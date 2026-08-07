/**
 * Prints the current exchange-netflow signal for BTC. Read-only — never
 * places an order, not wired into bot.js.
 *
 * Usage:
 *   node research/exchange-netflow/live-preview.js
 */
import { fetchWatchedWalletFlows } from "./lib/exchangeNetflowData.js";
import { fetchDailyCloses } from "./lib/priceData.js";
import { buildNetflowFeatureSeries } from "./lib/netflowFeatures.js";
import { computeFlowSignalSeries } from "./lib/flowSignal.js";

const DAYS = 240;

async function run() {
  const [priceBars, flowEvents] = await Promise.all([
    fetchDailyCloses("BTCUSDT", DAYS),
    fetchWatchedWalletFlows(DAYS),
  ]);

  const bars = buildNetflowFeatureSeries(priceBars, flowEvents);
  const signals = computeFlowSignalSeries(bars);
  const last = bars.length - 1;
  const s = signals[last];

  console.log(`=== BTCUSDT — ${new Date(bars[last].time).toISOString().slice(0, 10)} — close ${bars[last].close} ===`);
  if (!s) {
    console.log("Not enough history yet for a signal (needs 180+ days).");
    return;
  }
  console.log(`Direction:   ${s.direction}`);
  console.log(`Conviction:  ${s.conviction.toFixed(3)}`);
  console.log(`7d net flow: ${bars[last].cum7.toFixed(4)} BTC`);
  for (const line of s.rationale) console.log(`  - ${line}`);
}

run().catch((err) => {
  console.error("Live preview failed:", err.message);
  process.exit(1);
});
