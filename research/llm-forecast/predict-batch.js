/**
 * Runs a forward prediction across a whole watchlist in one invocation —
 * this is the intended single cron entry point instead of scheduling
 * predict.js separately per symbol.
 *
 * Usage:
 *   node research/llm-forecast/predict-batch.js
 *   node research/llm-forecast/predict-batch.js BTCUSDT,ETHUSDT,SOLUSDT 4
 *   WATCHLIST=BTCUSDT,ETHUSDT,SOLUSDT node research/llm-forecast/predict-batch.js
 *
 * Each symbol is a separate billed Claude API call — cost scales linearly
 * with watchlist size. A default 3-symbol watchlist is deliberate: crypto
 * assets are highly correlated (BTC-beta), so a much wider watchlist
 * mostly buys correlated repeats of the same market move, not proportionally
 * more independent evidence, while still costing proportionally more.
 *
 * A failure on one symbol doesn't stop the rest — logged and skipped.
 */
import "dotenv/config";
import { predictSymbol } from "./lib/runPrediction.js";

const [, , watchlistArg, horizonArg] = process.argv;
const WATCHLIST = (watchlistArg || process.env.WATCHLIST || "BTCUSDT,ETHUSDT,SOLUSDT")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const HORIZON_HOURS = parseInt(horizonArg || "4", 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log(`Running batch prediction for: ${WATCHLIST.join(", ")} (horizon ${HORIZON_HOURS}h)\n`);
  const ok = [], failed = [];

  for (const symbol of WATCHLIST) {
    console.log(`--- ${symbol} ---`);
    try {
      const entry = await predictSymbol(symbol, HORIZON_HOURS);
      console.log(`  ${entry.prediction.direction} (confidence ${entry.prediction.confidence})${entry.usedPlaybook ? " [playbook applied]" : ""}`);
      ok.push(symbol);
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      failed.push(symbol);
    }
    await sleep(1000); // stay polite to both the Binance and Claude APIs between symbols
  }

  console.log(`\nBatch complete: ${ok.length} logged, ${failed.length} failed.`);
  if (failed.length) console.log(`Failed: ${failed.join(", ")}`);
}

run();
