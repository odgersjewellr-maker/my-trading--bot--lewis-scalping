/**
 * NKB Walk-Forward + Fee Test — honest out-of-sample validation.
 *
 * Usage: node walkforward.js [csv-path]
 *   FEE_RATE=0.0006 SLIPPAGE=0.0005 IS_DAYS=730 OOS_DAYS=180 node walkforward.js
 *
 * Why this exists:
 *   backtest.js --optimize picks the best parameters on the SAME data it scores
 *   them on (in-sample overfitting) and models ZERO trading cost. Both flatter the
 *   result. This script answers the only question that matters before risking money:
 *   does the edge survive (a) realistic fees + slippage and (b) being chosen on the
 *   past and traded on the future it never saw?
 *
 *   Walk-forward analysis: optimise on a rolling in-sample window, trade the
 *   untouched next window with frozen params, roll forward, and stitch every
 *   out-of-sample segment into one continuous, bar-by-bar equity curve. That curve
 *   is the honest estimate of what trading this forward would have earned.
 *
 * The signal engine lives in nkb-engine.js (shared with strategy-lab.js).
 */

import { loadCandles, runBacktest, walkForward, BASE_CFG } from "./nkb-engine.js";

const FEE_RATE = parseFloat(process.env.FEE_RATE || "0.0006");   // taker fee per side (BitGet ≈ 0.06%)
const SLIPPAGE = parseFloat(process.env.SLIPPAGE || "0.0005");   // adverse fill per side (≈ 0.05%)
const IS_DAYS  = parseInt(process.env.IS_DAYS  || "730", 10);
const OOS_DAYS = parseInt(process.env.OOS_DAYS || "180", 10);
const overlay  = { feeRate: FEE_RATE, slippage: SLIPPAGE };

const csvPath = process.argv.filter((a) => !a.startsWith("--"))[2] || "btc-daily-binance.csv";
const candles = loadCandles(csvPath);

const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const money = (x) => `$${x.toFixed(0)}`;

console.log("\n═══════════════════════════════════════════════════════════════════════");
console.log("  NKB WALK-FORWARD + FEE TEST");
console.log("═══════════════════════════════════════════════════════════════════════");
console.log(`  Data:  ${candles[0].date} → ${candles[candles.length - 1].date}  (${candles.length} daily bars)`);
console.log(`  Costs: ${(FEE_RATE * 100).toFixed(3)}% fee + ${(SLIPPAGE * 100).toFixed(3)}% slippage per side  (round-trip ≈ ${((FEE_RATE + SLIPPAGE) * 2 * 100).toFixed(2)}% of notional)`);
console.log(`  Windows: ${IS_DAYS}d in-sample (optimise) → ${OOS_DAYS}d out-of-sample (trade), rolling\n`);

// 1) Full-sample, best-variant, with vs without fees — the pure fee drag.
const fullBase = { ...BASE_CFG, useADXHold: true, adxHoldThreshold: 25 };
const fullNoFee = runBacktest(candles, { ...fullBase, feeRate: 0, slippage: 0 });
const fullFee   = runBacktest(candles, { ...fullBase, ...overlay });
console.log("── 1. Fee drag (same params, full sample, ADX-hold>25) ────────────────");
console.log(`  ${"".padEnd(14)} ${"Final".padStart(10)} ${"Return".padStart(10)} ${"Trades".padStart(7)} ${"MaxDD".padStart(7)} ${"Sharpe".padStart(7)}`);
for (const [label, r] of [["no fees", fullNoFee], ["WITH fees", fullFee]]) {
  console.log(`  ${label.padEnd(14)} ${money(r.portfolio).padStart(10)} ${pct((r.portfolio - 1000) / 1000).padStart(10)} ${String(r.nTrades).padStart(7)} ${(r.maxDD.toFixed(0) + "%").padStart(7)} ${r.sharpe.toFixed(2).padStart(7)}`);
}
console.log(`  → fees alone cut the final balance by ${pct((fullFee.portfolio - fullNoFee.portfolio) / fullNoFee.portfolio)}\n`);

// 2) Walk-forward: the honest out-of-sample result.
const wf = walkForward(candles, { isDays: IS_DAYS, oosDays: OOS_DAYS, overlay });
console.log("── 2. Walk-forward windows (params chosen on IS, traded on OOS w/ fees) ─");
console.log(`  ${"OOS period".padEnd(23)} ${"chosen params".padEnd(34)} ${"trades".padStart(6)} ${"OOS ret".padStart(9)}`);
for (const w of wf.windows) {
  const p = `bm${w.cfg.bandMult} bw${w.cfg.bandwidth} stop${w.cfg.atrStopMult} cb${w.cfg.confirmBars} adx${w.cfg.useADXHold ? w.cfg.adxHoldThreshold : "off"}`;
  console.log(`  ${w.oosRange.padEnd(23)} ${p.padEnd(34)} ${String(w.oosTrades).padStart(6)} ${pct(w.growth - 1).padStart(9)}`);
}

console.log("\n── 3. VERDICT ─────────────────────────────────────────────────────────");
console.log(`  In-sample-optimised full run (the flattering number): ${money(fullNoFee.portfolio)}  (${pct((fullNoFee.portfolio - 1000) / 1000)})`);
console.log(`  Same, with realistic fees:                            ${money(fullFee.portfolio)}  (${pct((fullFee.portfolio - 1000) / 1000)})`);
console.log(`  HONEST walk-forward OOS, with fees:                   ${money(wf.stitched)}  (${pct((wf.stitched - 1000) / 1000)})`);
console.log(`    over ${wf.years.toFixed(1)} yrs traded out-of-sample  →  ${pct(wf.cagr)} / yr  |  OOS max drawdown ${(wf.maxDD * 100).toFixed(0)}% (bar-level)`);
const toTarget = wf.stitched > 1000 && wf.cagr > 0 ? Math.log(100) / Math.log(1 + wf.cagr) : Infinity;
console.log(`    at this OOS rate, $1k → $100k takes ${isFinite(toTarget) ? toTarget.toFixed(1) + " years" : "→ never (edge does not compound)"}`);
console.log("═══════════════════════════════════════════════════════════════════════\n");
