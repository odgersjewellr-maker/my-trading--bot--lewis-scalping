/**
 * Calls the Claude API directly (not Claude Code) so predictions can be
 * logged unattended on a schedule. Costs real, small amounts of money per
 * call — see README before running this on a tight loop.
 */
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = process.env.LLM_FORECAST_MODEL || "claude-sonnet-5";

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
      max_tokens: 500,
      tools: [PREDICTION_TOOL],
      tool_choice: { type: "tool", name: "record_prediction" },
      messages: [{ role: "user", content: promptText }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API request failed: ${res.status} ${res.statusText} — ${body}`);
  }

  const json = await res.json();
  const toolUse = json.content?.find((b) => b.type === "tool_use" && b.name === "record_prediction");
  if (!toolUse) throw new Error(`No prediction tool call in response: ${JSON.stringify(json)}`);

  return { ...toolUse.input, model: json.model, usage: json.usage };
}
