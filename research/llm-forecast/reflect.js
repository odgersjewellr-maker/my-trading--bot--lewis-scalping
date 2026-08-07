/**
 * Self-critique loop: reviews resolved predictions and writes
 * log/playbook.md, which predict.js/predict-batch.js then feed into
 * future prompts as extra context.
 *
 * IMPORTANT — what this is NOT: Claude's weights do not change. This is
 * not fine-tuning and it is not the model "learning" in any technical
 * sense. It's in-context self-critique — the same model reviewing its own
 * track record and writing itself a note. Treat the result accordingly.
 *
 * Gated behind a minimum sample size on purpose: with too few resolved
 * predictions, "patterns" found here are much more likely to be noise
 * than real signal, and an overconfident playbook is worse than no
 * playbook at all — it launders noise into something that looks like
 * earned wisdom.
 *
 * Usage:
 *   node research/llm-forecast/reflect.js
 *
 * Run this occasionally (e.g. weekly), not every cycle — it reviews
 * everything resolved so far each time, so running it more often than
 * that just re-spends money re-deriving the same conclusions.
 */
import "dotenv/config";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { readAll } from "./lib/logStore.js";
import { getReflection } from "./lib/llmClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK_PATH = join(__dirname, "log", "playbook.md");

const MIN_RESOLVED = 30; // same bar score.js uses before it'll draw a conclusion
const MAX_REVIEWED = 100; // caps prompt size/cost — most recent N resolved predictions

function buildReflectionPrompt(entries) {
  const rows = entries.map((e) => {
    const p = e.prediction, a = e.actual;
    return `${e.symbol} @ ${new Date(e.createdAt).toISOString()} | predicted ${p.direction} (conf ${p.confidence}) | actual ${a.direction} (${a.returnPct.toFixed(2)}%) | ${a.correct ? "CORRECT" : "WRONG"} | rationale: ${p.rationale}`;
  });

  return `You are reviewing your own past forward-looking price predictions to figure out what's actually working, if anything.

Below are ${entries.length} resolved predictions, each with what you predicted, your stated confidence, your rationale at the time, and what actually happened.

${rows.join("\n")}

Analyze honestly. Look for:
- Genuine patterns in what kinds of setups you called correctly vs incorrectly (specific indicator states, order-flow conditions, liquidity conditions, confidence levels)
- Whether your stated confidence actually tracks your accuracy, or is uncalibrated
- Any systematic bias (e.g. always predicting long, ignoring liquidity data, overweighting RSI, one symbol dragging down the rest)

Be skeptical of your own pattern-finding. With only ${entries.length} samples, most apparent patterns are noise, not signal — say so explicitly wherever it's the honest conclusion, rather than manufacturing a confident-sounding narrative.`;
}

async function run() {
  const entries = readAll().filter((e) => e.resolved && e.actual && e.actual.correct !== null);

  if (entries.length < MIN_RESOLVED) {
    console.log(`Only ${entries.length} resolved directional predictions logged — need at least ${MIN_RESOLVED} before reflecting.`);
    console.log("Reflecting earlier than that risks writing a playbook based on noise. Keep running predict/score.");
    return;
  }

  const reviewed = entries.slice(-MAX_REVIEWED);
  const overallAccuracy = reviewed.filter((e) => e.actual.correct).length / reviewed.length;

  console.log(`Reflecting on ${reviewed.length} of ${entries.length} total resolved predictions...`);
  const reflection = await getReflection(buildReflectionPrompt(reviewed));

  const playbook = `# Self-critique playbook

Generated: ${new Date().toISOString()}
Based on: ${reviewed.length} resolved predictions (of ${entries.length} total available at generation time)
Overall accuracy on this sample: ${(overallAccuracy * 100).toFixed(1)}% (vs 50% coin-flip baseline)

**Read this skeptically.** It was written by the same model making the predictions,
reviewing a sample that may still be too small to generalize from — it is not
verified fact, it's the model's best self-assessment.

## What worked
${reflection.whatWorked}

## What failed
${reflection.whatFailed}

## Calibration
${reflection.calibrationNote}

## Guidance for future predictions
${reflection.guidanceForFuturePredictions}
`;

  writeFileSync(PLAYBOOK_PATH, playbook);
  console.log(`\nWrote ${PLAYBOOK_PATH}`);
  console.log(`Overall accuracy on reviewed sample: ${(overallAccuracy * 100).toFixed(1)}%`);
  console.log("Future predict.js / predict-batch.js runs will now include this playbook as context.");
}

run().catch((err) => {
  console.error("Reflection failed:", err.message);
  process.exit(1);
});
