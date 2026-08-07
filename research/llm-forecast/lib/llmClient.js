/**
 * Calls the Claude API directly (not Claude Code) so predictions and
 * reflections can run unattended on a schedule. Costs real, small amounts
 * of money per call — see README before running this on a tight loop.
 */
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = process.env.LLM_FORECAST_MODEL || "claude-sonnet-5";

async function callTool(promptText, tool, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set. Get one at https://console.anthropic.com/ and add it to .env");
  }

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: maxTokens,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: promptText }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API request failed: ${res.status} ${res.statusText} — ${body}`);
  }

  const json = await res.json();
  const toolUse = json.content?.find((b) => b.type === "tool_use" && b.name === tool.name);
  if (!toolUse) throw new Error(`No ${tool.name} tool call in response: ${JSON.stringify(json)}`);

  return { ...toolUse.input, model: json.model, usage: json.usage };
}

const PREDICTION_TOOL = {
  name: "record_prediction",
  description: "Record a directional forecast for the given symbol over the stated horizon.",
  input_schema: {
    type: "object",
    properties: {
      direction: {
        type: "string",
        enum: ["long", "short", "flat"],
        description: "flat only if you genuinely see no edge — don't use it as a default hedge",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Calibrated probability this direction is correct. This will be scored against realized outcomes across many predictions, so don't inflate it.",
      },
      rationale: { type: "string", description: "1-3 sentences: what in the data drove this call." },
    },
    required: ["direction", "confidence", "rationale"],
  },
};

export async function getPrediction(promptText) {
  return callTool(promptText, PREDICTION_TOOL, 500);
}

const REFLECTION_TOOL = {
  name: "record_playbook",
  description: "Record a structured, skeptical self-critique of past prediction performance.",
  input_schema: {
    type: "object",
    properties: {
      whatWorked: {
        type: "string",
        description: "Specific, concrete patterns that correlated with correct calls. Say 'none clearly identifiable' if that's the honest answer.",
      },
      whatFailed: {
        type: "string",
        description: "Specific, concrete patterns that correlated with incorrect calls.",
      },
      calibrationNote: {
        type: "string",
        description: "Does stated confidence actually track accuracy? Any systematic over- or under-confidence, or directional bias (e.g. always calling long)?",
      },
      guidanceForFuturePredictions: {
        type: "string",
        description: "Concrete, actionable guidance — not vague encouragement. If the honest answer is 'sample too small, no reliable pattern yet, stay cautious', say exactly that.",
      },
    },
    required: ["whatWorked", "whatFailed", "calibrationNote", "guidanceForFuturePredictions"],
  },
};

export async function getReflection(promptText) {
  return callTool(promptText, REFLECTION_TOOL, 1500);
}
