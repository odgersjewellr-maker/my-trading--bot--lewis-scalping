/**
 * Walk-forward backtest for the stablecoin mint-flow signal.
 *
 * Usage:
 *   node research/stablecoin-flow/backtest.js [SYMBOL] [DAYS]
 *   node research/stablecoin-flow/backtest.js SOLUSDT 720
 *
 * Requires a free ETHERSCAN_API_KEY in .env — see README.md.
 *
 * Offline / research only — does not touch bot.js, rules.json, or place
 * any orders. Same one-bar-forward-hold convention as causal-fusion's
 * backtest, just on daily bars: exposure each day is sized by that day's
 * conviction and marked to market against the next day's return, with a
 * flat turnover cost. Because the underlying flow features are slow-moving
 * (3/7/14-day cumulative sums), conviction naturally persists across
 * several days when it's elevated — there's no need to hard-code a fixed
 * holding period separately.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { fetchStablecoinMintEvents } from "./lib/etherscanData.js";
import { fetchDailyCloses } from "./lib/priceData.js";
import { buildMintFeatureSeries } from "./lib/mintFeatures.js";
import { computeFlowSignalSeries } from "./lib/flowSignal.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "out");
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const FEE_RATE = 0.0005;
const BARS_PER_YEAR = 365;

const [, , symbolArg, daysArg] = process.argv;
const SYMBOL = symbolArg || "BTCUSDT";
const DAYS = parseInt(daysArg || "720", 10); // ~2yr default — mint events are sparse, needs history

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function std(a) { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); }

async function run() {
  console.log(`Fetching ${SYMBOL} daily closes (${DAYS}d) and USDT/USDC mint events...`);
  const [priceBars, mintEvents] = await Promise.all([
    fetchDailyCloses(SYMBOL, DAYS),
    fetchStablecoinMintEvents(),
  ]);
  console.log(`  price bars: ${priceBars.length}  mint/burn events: ${mintEvents.length}`);

  const bars = buildMintFeatureSeries(priceBars, mintEvents);
  const signals = computeFlowSignalSeries(bars);

  let equity = 1, equityBH = 1;
  let prevExposure = 0;
  let peak = 1, maxDD = 0, peakBH = 1, maxDDBH = 0;
  const stratRets = [];
  const rows = [["time", "close", "direction", "conviction", "leadingStream", "dailyNetFlow", "stratRet", "equity", "equityBuyHold"]];
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
      s.direction, s.conviction.toFixed(3), s.leadingStream ?? "", bars[i].dailyNetFlow.toFixed(0),
      stratRet.toFixed(6), equity.toFixed(6), equityBH.toFixed(6),
    ]);

    prevExposure = exposure;
  }

  const sharpe = std(stratRets) === 0 ? 0 : (mean(stratRets) / std(stratRets)) * Math.sqrt(BARS_PER_YEAR);
  const outPath = join(OUT_DIR, `equity-${SYMBOL}-mintflow.csv`);
  writeFileSync(outPath, rows.map((r) => r.join(",")).join("\n"));

  console.log("\n=== Backtest report ===");
  console.log(`Symbol:            ${SYMBOL}`);
  console.log(`Days evaluated:    ${bars.length - 1}`);
  console.log(`Active bars:       ${activeBars} (${((activeBars / (bars.length - 1)) * 100).toFixed(1)}%)`);
  console.log(`Avg conviction:    ${activeBars ? (sumConviction / activeBars).toFixed(3) : "n/a"}`);
  console.log(`Win rate (active): ${activeBars ? ((winBars / activeBars) * 100).toFixed(1) : "n/a"}%`);
  console.log(`Strategy return:   ${((equity - 1) * 100).toFixed(2)}%`);
  console.log(`Buy & hold return: ${((equityBH - 1) * 100).toFixed(2)}%`);
  console.log(`Annualized Sharpe: ${sharpe.toFixed(2)}`);
  console.log(`Max drawdown:      ${(maxDD * 100).toFixed(2)}%  (buy&hold: ${(maxDDBH * 100).toFixed(2)}%)`);
  console.log(`\nEquity curve written to ${outPath}`);
  console.log(`\nMint/burn events used: ${mintEvents.length} — if this number is small (a few dozen),`);
  console.log("treat any Sharpe/return number here with real skepticism: sparse-event strategies");
  console.log("are the easiest kind to accidentally overfit to a handful of lucky days.");
}

run().catch((err) => {
  console.error("Backtest failed:", err.message);
  process.exit(1);
});
