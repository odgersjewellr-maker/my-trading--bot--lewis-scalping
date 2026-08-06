/**
 * Walk-forward backtest for the causal-fusion signal.
 *
 * Usage:
 *   node research/causal-fusion/backtest.js [SYMBOL] [INTERVAL] [DAYS]
 *   node research/causal-fusion/backtest.js SOLUSDT 1h 45
 *
 * This is offline research only — it does not touch bot.js, rules.json,
 * or place any orders. It reads/writes only inside research/causal-fusion/.
 *
 * The signal at bar i forecasts the sign of ret[i+1]. The backtest holds a
 * position sized by conviction[i] for exactly that one bar — it does not
 * model multi-bar holds, stops, or take-profits, because the signal itself
 * doesn't claim to predict beyond one bar. A flat ~5bps round-trip cost is
 * charged on every change in exposure to keep the numbers honest about
 * turnover.
 */
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { fetchFuturesKlines, fetchFundingHistory, fetchOpenInterestHistory } from "./lib/binanceData.js";
import { buildFeatureSeries } from "./lib/features.js";
import { computeLeadLagSeries } from "./lib/leadlag.js";
import { computeCascadeSeries } from "./lib/cascade.js";
import { buildSignalSeries } from "./lib/signal.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "out");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const FEE_RATE = 0.0005; // ~5bps per unit of exposure change (round-trip taker fee proxy)

const [, , symbolArg, intervalArg, daysArg] = process.argv;
const SYMBOL = symbolArg || "BTCUSDT";
const INTERVAL = intervalArg || "1h";
const DAYS = parseInt(daysArg || "45", 10);
const BARS_PER_YEAR = { "1h": 24 * 365, "4h": 6 * 365, "1d": 365 }[INTERVAL] || 24 * 365;

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a) { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); }

async function run() {
  console.log(`Fetching ${SYMBOL} ${INTERVAL} data (${DAYS}d)...`);
  const [klines, funding, openInterest] = await Promise.all([
    fetchFuturesKlines(SYMBOL, INTERVAL, DAYS),
    fetchFundingHistory(SYMBOL, DAYS),
    fetchOpenInterestHistory(SYMBOL, INTERVAL === "1d" ? "1d" : "1h"),
  ]);
  console.log(`  klines: ${klines.length}  funding events: ${funding.length}  OI points: ${openInterest.length}`);

  const bars = buildFeatureSeries({ klines, funding, openInterest });
  const leadLagSeries = computeLeadLagSeries(bars);
  const cascadeSeries = computeCascadeSeries(bars);
  const signals = buildSignalSeries(bars, leadLagSeries, cascadeSeries);

  let equity = 1, equityBH = 1;
  let prevExposure = 0;
  let peak = 1, maxDD = 0, peakBH = 1, maxDDBH = 0;
  const stratRets = [];
  const rows = [["time", "close", "direction", "conviction", "leadingStream", "cascadeRisk", "stratRet", "equity", "equityBuyHold"]];
  let activeBars = 0, winBars = 0, sumConviction = 0;

  for (let i = 0; i < bars.length - 1; i++) {
    const s = signals[i];
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
      new Date(bars[i + 1].time).toISOString(), bars[i + 1].close.toFixed(2), s.direction,
      s.conviction.toFixed(3), s.leadingStream ?? "", s.cascadeRisk.toFixed(2),
      stratRet.toFixed(6), equity.toFixed(6), equityBH.toFixed(6),
    ]);

    prevExposure = exposure;
  }

  const sharpe = std(stratRets) === 0 ? 0 : (mean(stratRets) / std(stratRets)) * Math.sqrt(BARS_PER_YEAR);
  const outPath = join(OUT_DIR, `equity-${SYMBOL}-${INTERVAL}.csv`);
  writeFileSync(outPath, rows.map((r) => r.join(",")).join("\n"));

  console.log("\n=== Backtest report ===");
  console.log(`Symbol/interval:   ${SYMBOL} / ${INTERVAL}`);
  console.log(`Bars evaluated:    ${bars.length - 1}`);
  console.log(`Active bars:       ${activeBars} (${((activeBars / (bars.length - 1)) * 100).toFixed(1)}%)`);
  console.log(`Avg conviction:    ${activeBars ? (sumConviction / activeBars).toFixed(3) : "n/a"}`);
  console.log(`Win rate (active): ${activeBars ? ((winBars / activeBars) * 100).toFixed(1) : "n/a"}%`);
  console.log(`Strategy return:   ${((equity - 1) * 100).toFixed(2)}%`);
  console.log(`Buy & hold return: ${((equityBH - 1) * 100).toFixed(2)}%`);
  console.log(`Annualized Sharpe: ${sharpe.toFixed(2)}`);
  console.log(`Max drawdown:      ${(maxDD * 100).toFixed(2)}%  (buy&hold: ${(maxDDBH * 100).toFixed(2)}%)`);
  console.log(`\nEquity curve written to ${outPath}`);
  console.log("\nReminder: this is one backtest window on one symbol. Treat it as a first read,");
  console.log("not proof of an edge — re-run across symbols/periods and check parameter sensitivity");
  console.log("before trusting it with size.");
}

run().catch((err) => {
  console.error("Backtest failed:", err);
  process.exit(1);
});
