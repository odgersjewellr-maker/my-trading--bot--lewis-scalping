/**
 * Shared "predict one symbol" pipeline — used by both predict.js (single
 * symbol) and predict-batch.js (watchlist loop) so there's one place that
 * defines what a prediction actually is.
 */
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import {
  fetchRecentKlines,
  fetchOrderBookSnapshot,
  fetchLatestFunding,
  fetchLatestOpenInterest,
} from "./binanceSnapshot.js";
import { buildSnapshot } from "./buildPrompt.js";
import { getPrediction } from "./llmClient.js";
import { append } from "./logStore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLAYBOOK_PATH = join(__dirname, "..", "log", "playbook.md");

function loadPlaybook() {
  return existsSync(PLAYBOOK_PATH) ? readFileSync(PLAYBOOK_PATH, "utf8") : null;
}

export async function predictSymbol(symbol, horizonHours) {
  const [klines, orderBook, funding, openInterest] = await Promise.all([
    fetchRecentKlines(symbol, 100, "1h"),
    fetchOrderBookSnapshot(symbol, 20),
    fetchLatestFunding(symbol),
    fetchLatestOpenInterest(symbol),
  ]);

  const playbook = loadPlaybook();
  const snapshot = buildSnapshot({ symbol, klines, orderBook, funding, openInterest, horizonHours, playbook });
  const prediction = await getPrediction(snapshot.text);

  const last = klines[klines.length - 1];
  const createdAt = last.openTime;
  const targetAt = createdAt + horizonHours * 3600_000;

  const entry = {
    id: `${symbol}-${createdAt}`,
    symbol,
    createdAt,
    targetAt,
    horizonHours,
    priceAtCreation: last.close,
    indicators: snapshot.indicators,
    orderBook,
    funding,
    openInterest,
    usedPlaybook: playbook !== null,
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
  return entry;
}
