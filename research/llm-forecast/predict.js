/**
 * Logs one forward-looking prediction for a single symbol. For multiple
 * tickers in one run, use predict-batch.js instead.
 *
 * Usage:
 *   node research/llm-forecast/predict.js [SYMBOL] [HORIZON_HOURS]
 *   node research/llm-forecast/predict.js SOLUSDT 4
 *
 * Offline / research only — never places an order, not wired into bot.js.
 * Each call is a real, billed Claude API request.
 */
import "dotenv/config";
import { predictSymbol } from "./lib/runPrediction.js";

const [, , symbolArg, horizonArg] = process.argv;
const SYMBOL = symbolArg || "BTCUSDT";
const HORIZON_HOURS = parseInt(horizonArg || "4", 10);

async function run() {
  console.log(`Fetching live snapshot for ${SYMBOL}...`);
  const entry = await predictSymbol(SYMBOL, HORIZON_HOURS);

  console.log(`\nLogged prediction for ${entry.symbol} @ ${new Date(entry.createdAt).toISOString()}`);
  console.log(`  Direction:  ${entry.prediction.direction}`);
  console.log(`  Confidence: ${entry.prediction.confidence}`);
  console.log(`  Rationale:  ${entry.prediction.rationale}`);
  console.log(`  Resolves:   ${new Date(entry.targetAt).toISOString()}`);
  if (entry.usedPlaybook) console.log(`  (informed by the accumulated self-critique playbook)`);
}

run().catch((err) => {
  console.error("Prediction failed:", err.message);
  process.exit(1);
});
