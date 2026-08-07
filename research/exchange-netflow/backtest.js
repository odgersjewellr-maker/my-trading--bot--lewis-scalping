/**
 * Walk-forward backtest for the exchange-netflow signal (BTC only — the
 * watched wallet is a Bitcoin address).
 *
 * Usage:
 *   node research/exchange-netflow/backtest.js [DAYS]
 *   node research/exchange-netflow/backtest.js 365
 *
 * Offline / research only — does not touch bot.js, rules.json, or place
 * any orders. Same daily-exposure, one-day-forward convention as
 * stablecoin-flow's backtest.
 */
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { fetchWatchedWalletFlows } from "./lib/exchangeNetflowData.js";
import { fetchDailyCloses } from "./lib/priceData.js";
import { buildNetflowFeatureSeries } from "./lib/netflowFeatures.js";
import { computeFlowSignalSeries } from "./lib/flowSignal.js";
import { BTC_EXCHANGE_WALLETS } from "./lib/knownWallets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "out");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const FEE_RATE = 0.0005;
const BARS_PER_YEAR = 365;
const SYMBOL = "BTCUSDT";

const [, , daysArg] = process.argv;
const DAYS = parseInt(daysArg || "365", 10);

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a) { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); }

async function run() {
  console.log(`Watched wallets: ${BTC_EXCHANGE_WALLETS.map((w) => w.label).join(", ")}`);
  console.log(`Fetching BTC daily closes (${DAYS}d) and on-chain flow history...`);
  const [priceBars, flowEvents] = await Promise.all([
    fetchDailyCloses(SYMBOL, DAYS),
    fetchWatchedWalletFlows(DAYS),
  ]);
  console.log(`  price bars: ${priceBars.length}  flow events: ${flowEvents.length}`);

  const bars = buildNetflowFeatureSeries(priceBars, flowEvents);
  const signals = computeFlowSignalSeries(bars);

  let equity = 1, equityBH = 1;
  let prevExposure = 0;
  let peak = 1, maxDD = 0, peakBH = 1, maxDDBH = 0;
  const stratRets = [];
  const rows = [["time", "close", "direction", "conviction", "leadingStream", "dailyNetFlowBTC", "stratRet", "equity", "equityBuyHold"]];
  let activeBars = 0, winBars = 0, sumConviction = 0;

  for (let i = 0; i < bars.length - 1; i++) {
    const s = signals[i];
    if (!s) continue;
    const sign = s.direction === "long" ? 1 : s.direction === "short" ? -1 : 0;
    const exposure = sign * s.conviction;
    const nextRet = bars[i + 1].ret;

    const turnoverCost = Math.abs(exposure - prevExposure) * FEE_RATE;
    const stratRet = exposure * nextRet - turnoverCost;
    stratRets.push(stratRet);

    equity *= (1 + stratRet);
    equityBH *= (1 + nextRet);
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity / peak - 1);
    peakBH = Math.max(peakBH, equityBH);
    maxDDBH = Math.min(maxDDBH, equityBH / peakBH - 1);

    if (exposure !== 0) {
      activeBars++;
      sumConviction += s.conviction;
      if (stratRet > 0) winBars++;
    }

    rows.push([
      new Date(bars[i + 1].time).toISOString().slice(0, 10), bars[i + 1].close.toFixed(2),
      s.direction, s.conviction.toFixed(3), s.leadingStream ?? "", bars[i].dailyNetFlow.toFixed(4),
      stratRet.toFixed(6), equity.toFixed(6), equityBH.toFixed(6),
    ]);

    prevExposure = exposure;
  }

  const sharpe = std(stratRets) === 0 ? 0 : (mean(stratRets) / std(stratRets)) * Math.sqrt(BARS_PER_YEAR);
  const outPath = join(OUT_DIR, `equity-BTCUSDT-netflow.csv`);
  writeFileSync(outPath, rows.map((r) => r.join(",")).join("\n"));

  console.log("\n=== Backtest report ===");
  console.log(`Days evaluated:    ${bars.length - 1}`);
  console.log(`Active bars:       ${activeBars} (${((activeBars / (bars.length - 1)) * 100).toFixed(1)}%)`);
  console.log(`Avg conviction:    ${activeBars ? (sumConviction / activeBars).toFixed(3) : "n/a"}`);
  console.log(`Win rate (active): ${activeBars ? ((winBars / activeBars) * 100).toFixed(1) : "n/a"}%`);
  console.log(`Strategy return:   ${((equity - 1) * 100).toFixed(2)}%`);
  console.log(`Buy & hold return: ${((equityBH - 1) * 100).toFixed(2)}%`);
  console.log(`Annualized Sharpe: ${sharpe.toFixed(2)}`);
  console.log(`Max drawdown:      ${(maxDD * 100).toFixed(2)}%  (buy&hold: ${(maxDDBH * 100).toFixed(2)}%)`);
  console.log(`\nEquity curve written to ${outPath}`);
  console.log(`\nFlow events used: ${flowEvents.length} across ${BTC_EXCHANGE_WALLETS.length} watched wallet(s).`);
  console.log("This is a single-wallet proof of concept, not a comprehensive netflow tracker —");
  console.log("treat any result here with more skepticism than causal-fusion or stablecoin-flow.");
}

run().catch((err) => {
  console.error("Backtest failed:", err.message);
  process.exit(1);
});
