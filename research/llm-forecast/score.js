/**
 * Resolves any due predictions against realized price, then prints a
 * running scorecard. Safe to run as often as you like — it only reads
 * price data (free), never calls the paid Claude API.
 *
 * Usage:
 *   node research/llm-forecast/score.js [SYMBOL]
 */
import "dotenv/config";
import { fetchKlineAt } from "./lib/binanceSnapshot.js";
import { readAll, rewriteAll } from "./lib/logStore.js";

const symbolFilter = process.argv[2];

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }

async function resolveDue(entries) {
  const now = Date.now();
  let resolvedCount = 0;

  for (const e of entries) {
    if (e.resolved || e.targetAt > now) continue;

    const kline = await fetchKlineAt(e.symbol, e.targetAt, "1h");
    if (!kline) continue; // data not available yet, try again later

    const actualReturnPct = ((kline.close - e.priceAtCreation) / e.priceAtCreation) * 100;
    const actualDirection = actualReturnPct > 0 ? "long" : actualReturnPct < 0 ? "short" : "flat";
    const predicted = e.prediction.direction;
    const correct = predicted === "flat" ? null : predicted === actualDirection;

    e.resolved = true;
    e.actual = { closeAtTarget: kline.close, returnPct: actualReturnPct, direction: actualDirection, correct };
    resolvedCount++;
  }

  return resolvedCount;
}

function printScorecard(entries) {
  const resolved = entries.filter((e) => e.resolved && (!symbolFilter || e.symbol === symbolFilter));
  const directional = resolved.filter((e) => e.prediction.direction !== "flat");
  const flatCalls = resolved.filter((e) => e.prediction.direction === "flat");
  const correct = directional.filter((e) => e.actual.correct);

  console.log(`\n=== Scorecard${symbolFilter ? ` (${symbolFilter})` : ""} ===`);
  console.log(`Total resolved predictions: ${resolved.length}`);
  console.log(`  Directional (long/short):  ${directional.length}`);
  console.log(`  Flat (abstained):          ${flatCalls.length}`);

  if (directional.length === 0) {
    console.log("\nNo directional predictions resolved yet — nothing to score.");
    return;
  }

  const accuracy = correct.length / directional.length;
  const avgConfidence = mean(directional.map((e) => e.prediction.confidence));
  const avgConfidenceWhenCorrect = mean(correct.map((e) => e.prediction.confidence));
  const avgConfidenceWhenWrong = mean(directional.filter((e) => !e.actual.correct).map((e) => e.prediction.confidence));

  console.log(`\nDirectional accuracy: ${(accuracy * 100).toFixed(1)}% (${correct.length}/${directional.length})`);
  console.log(`Coin-flip baseline:   50.0%`);
  console.log(`Avg stated confidence: ${avgConfidence.toFixed(2)}`);
  console.log(`  ...when correct:     ${Number.isNaN(avgConfidenceWhenCorrect) ? "n/a" : avgConfidenceWhenCorrect.toFixed(2)}`);
  console.log(`  ...when wrong:       ${Number.isNaN(avgConfidenceWhenWrong) ? "n/a" : avgConfidenceWhenWrong.toFixed(2)}`);
  console.log(`  (if these two are close together, confidence isn't tracking accuracy — the model is poorly calibrated)`);

  if (directional.length < 30) {
    console.log(`\nOnly ${directional.length} resolved directional predictions — far too few to draw a conclusion.`);
    console.log("Keep logging. 30 is a bare minimum; 100+ is where this starts being informative.");
  }

  const bySymbol = {};
  for (const e of directional) {
    (bySymbol[e.symbol] ??= []).push(e);
  }
  console.log("\nBy symbol:");
  for (const [sym, list] of Object.entries(bySymbol)) {
    const acc = list.filter((e) => e.actual.correct).length / list.length;
    console.log(`  ${sym}: ${(acc * 100).toFixed(1)}% (n=${list.length})`);
  }
}

async function run() {
  const entries = readAll();
  console.log(`Loaded ${entries.length} logged predictions.`);

  const resolvedNow = await resolveDue(entries);
  if (resolvedNow > 0) {
    rewriteAll(entries);
    console.log(`Resolved ${resolvedNow} newly-due prediction(s) against realized price.`);
  }

  printScorecard(entries);
}

run().catch((err) => {
  console.error("Scoring failed:", err.message);
  process.exit(1);
});
