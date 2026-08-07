/**
 * Prints the current stablecoin mint-flow signal for one or more symbols.
 * Read-only — never places an order, not wired into bot.js.
 *
 * Usage:
 *   node research/stablecoin-flow/live-preview.js
 *   node research/stablecoin-flow/live-preview.js SOLUSDT
 */
import "dotenv/config";
import { fetchStablecoinMintEvents } from "./lib/etherscanData.js";
import { fetchDailyCloses } from "./lib/priceData.js";
import { buildMintFeatureSeries } from "./lib/mintFeatures.js";
import { computeFlowSignalSeries } from "./lib/flowSignal.js";

const symbolArg = process.argv[2];
const SYMBOLS = symbolArg ? [symbolArg] : ["BTCUSDT", "SOLUSDT"];
const DAYS = 240; // > WINDOW(180) so the lead-lag estimate has a full trailing window

async function run() {
  const mintEvents = await fetchStablecoinMintEvents();
  console.log(`Loaded ${mintEvents.length} USDT/USDC mint/burn events.\n`);

  for (const symbol of SYMBOLS) {
    try {
      const priceBars = await fetchDailyCloses(symbol, DAYS);
      const bars = buildMintFeatureSeries(priceBars, mintEvents);
      const signals = computeFlowSignalSeries(bars);
      const last = bars.length - 1;
      const s = signals[last];

      console.log(`=== ${symbol} — ${new Date(bars[last].time).toISOString().slice(0, 10)} — close ${bars[last].close} ===`);
      if (!s) {
        console.log("  Not enough history yet for a signal (needs 180+ days).");
        continue;
      }
      console.log(`Direction:   ${s.direction}`);
      console.log(`Conviction:  ${s.conviction.toFixed(3)}`);
      console.log(`7d net flow: ${bars[last].cum7.toFixed(0)} USD-equivalent`);
      for (const line of s.rationale) console.log(`  - ${line}`);
      console.log("");
    } catch (err) {
      console.error(`${symbol} failed:`, err.message);
    }
  }
}

run();
