/**
 * Prints the current causal-fusion signal for one or more symbols.
 * Read-only / paper-only — this file never places an order and is not
 * wired into bot.js. It's for eyeballing what the signal is saying right
 * now while the strategy is still in research.
 *
 * Usage:
 *   node research/causal-fusion/live-preview.js
 *   node research/causal-fusion/live-preview.js SOLUSDT
 */
import { fetchFuturesKlines, fetchFundingHistory, fetchOpenInterestHistory } from "./lib/binanceData.js";
import { buildFeatureSeries } from "./lib/features.js";
import { computeLeadLagSeries } from "./lib/leadlag.js";
import { computeCascadeSeries } from "./lib/cascade.js";
import { combineSignal } from "./lib/signal.js";

const symbolArg = process.argv[2];
const SYMBOLS = symbolArg ? [symbolArg] : ["BTCUSDT", "SOLUSDT"];
const INTERVAL = "1h";
const DAYS = 20; // enough for the WINDOW=96 / BASELINE_WINDOW=200-bar lookbacks at 1h

async function previewSymbol(symbol) {
  const [klines, funding, openInterest] = await Promise.all([
    fetchFuturesKlines(symbol, INTERVAL, DAYS),
    fetchFundingHistory(symbol, DAYS),
    fetchOpenInterestHistory(symbol, "1h"),
  ]);

  const bars = buildFeatureSeries({ klines, funding, openInterest });
  const leadLagSeries = computeLeadLagSeries(bars);
  const cascadeSeries = computeCascadeSeries(bars);

  const last = bars.length - 1;
  const signal = combineSignal(leadLagSeries[last], cascadeSeries[last]);

  console.log(`\n=== ${symbol} — ${new Date(bars[last].time).toISOString()} — close ${bars[last].close} ===`);
  console.log(`Direction:   ${signal.direction}`);
  console.log(`Conviction:  ${signal.conviction.toFixed(3)}`);
  console.log(`Cascade risk: ${signal.cascadeRisk.toFixed(2)} (direction ${signal.cascadeDirection})`);
  for (const line of signal.rationale) console.log(`  - ${line}`);
}

async function run() {
  for (const symbol of SYMBOLS) {
    try {
      await previewSymbol(symbol);
    } catch (err) {
      console.error(`${symbol} failed:`, err.message);
    }
  }
}

run();
