/**
 * Logs one forward-looking prediction for a symbol. Run this periodically
 * (e.g. every 4-6h via cron) — NOT every bar. Each call is a real,
 * billed Claude API request; see README for cost notes.
 *
 * Usage:
 *   node research/llm-forecast/predict.js [SYMBOL] [HORIZON_HOURS]
 *   node research/llm-forecast/predict.js SOLUSDT 4
 *
 * Offline / research only — never places an order, not wired into bot.js.
 */
import "dotenv/config";
import {
  fetchRecentKlines,
  fetchOrderBookSnapshot,
  fetchLatestFunding,
  fetchLatestOpenInterest,
} from "./lib/binanceSnapshot.js";
import { buildSnapshot } from "./lib/buildPrompt.js";
import { getPrediction } from "./lib/llmClient.js";
import { append } from "./lib/logStore.js";

const [, , symbolArg, horizonArg] = process.argv;
const SYMBOL = symbolArg || "BTCUSDT";
const HORIZON_HOURS = parseInt(horizonArg || "4", 10);

async function run() {
  console.log(`Fetching live snapshot for ${SYMBOL}...`);
  const [klines, orderBook, funding, openInterest] = await Promise.all([
    fetchRecentKlines(SYMBOL, 100, "1h"),
    fetchOrderBookSnapshot(SYMBOL, 20),
    fetchLatestFunding(SYMBOL),
    fetchLatestOpenInterest(SYMBOL),
  ]);

  const snapshot = buildSnapshot({ symbol: SYMBOL, klines, orderBook, funding, openInterest, horizonHours: HORIZON_HOURS });

  console.log("Asking Claude for a prediction...");
  const prediction = await getPrediction(snapshot.text);

  const last = klines[klines.length - 1];
  const createdAt = last.openTime;
  const targetAt = createdAt + HORIZON_HOURS * 3600_000;

  const entry = {
    id: `${SYMBOL}-${createdAt}`,
    symbol: SYMBOL,
    createdAt,
    targetAt,
    horizonHours: HORIZON_HOURS,
    priceAtCreation: last.close,
    indicators: snapshot.indicators,
    orderBook,
    funding,
    openInterest,
    prediction: {
      direction: prediction.direction,
      confidence: prediction.confidence,
      rationale: prediction.rationale,
    },
    model: prediction.model,
    usage: prediction.usage,
    resolved: false,
    actual: null,
  };

  append(entry);

  console.log(`\nLogged prediction for ${SYMBOL} @ ${new Date(createdAt).toISOString()}`);
  console.log(`  Direction:  ${prediction.direction}`);
  console.log(`  Confidence: ${prediction.confidence}`);
  console.log(`  Rationale:  ${prediction.rationale}`);
  console.log(`  Resolves:   ${new Date(targetAt).toISOString()}`);
}

run().catch((err) => {
  console.error("Prediction failed:", err.message);
  process.exit(1);
});
