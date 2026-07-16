/**
 * Strategy Lab — A/B test candidate improvements to the NKB strategy.
 *
 * Usage: node strategy-lab.js [csv-path]
 *
 * Each variant applies a candidate overlay (an extra filter or sizing rule) on
 * top of the SAME walk-forward process as walkforward.js: params are still
 * optimised in-sample and traded out-of-sample with realistic fees. So every
 * row answers one question — "does adding THIS actually improve the honest,
 * out-of-sample result, or does it just look good in a curve-fit?"
 *
 * Ranked by MAR (CAGR ÷ max drawdown) — return per unit of pain, which is what
 * decides whether a $1k→$100k path is survivable, not raw return.
 */

import { loadCandles, walkForward } from "./nkb-engine.js";

const csvPath = process.argv.filter((a) => !a.startsWith("--"))[2] || "btc-daily-binance.csv";
const candles = loadCandles(csvPath);

// Candidate overlays. Baseline = the current strategy (grid over NKB + ADX-hold).
const VARIANTS = [
  { name: "Baseline (NKB + ADX-hold)", overlay: {} },
  { name: "+ ADX entry filter (>20)", overlay: { adxEntryMin: 20 } },
  { name: "+ ADX entry filter (>25)", overlay: { adxEntryMin: 25 } },
  { name: "+ 200-EMA trend bias", overlay: { trendFilterEMA: 200 } },
  { name: "+ Risk sizing (2%/trade)", overlay: { riskPct: 0.02 } },
  { name: "+ False-breakout guard (2xATR)", overlay: { maxExtensionATR: 2.0 } },
  { name: "+ False-breakout guard (1xATR)", overlay: { maxExtensionATR: 1.0 } },
  { name: "Combined (ADX20 + risk2% + FBguard2)", overlay: { adxEntryMin: 20, riskPct: 0.02, maxExtensionATR: 2.0 } },
];

console.log("\n═══════════════════════════════════════════════════════════════════════════════");
console.log("  STRATEGY LAB — walk-forward, out-of-sample, with fees");
console.log("═══════════════════════════════════════════════════════════════════════════════");
console.log(`  Data: ${candles[0].date} → ${candles[candles.length - 1].date}  (${candles.length} bars)`);
console.log(`  Each variant re-optimised in-sample, traded out-of-sample. Fees on every fill.\n`);

const rows = [];
for (const v of VARIANTS) {
  process.stdout.write(`  running: ${v.name} ...`.padEnd(48) + "\r");
  const r = walkForward(candles, { overlay: v.overlay });
  const mar = r.maxDD > 0 ? r.cagr / r.maxDD : 0;
  rows.push({ name: v.name, final: r.stitched, cagr: r.cagr, maxDD: r.maxDD, trades: r.totalTrades, mar });
}

const baseline = rows[0];
rows.sort((a, b) => b.mar - a.mar);

const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;
console.log(" ".repeat(80));
console.log(`  ${"Variant".padEnd(38)} ${"OOS final".padStart(10)} ${"CAGR".padStart(7)} ${"MaxDD".padStart(7)} ${"Trades".padStart(7)} ${"MAR".padStart(6)}`);
console.log("  " + "─".repeat(80));
for (const r of rows) {
  const tag = r.name === baseline.name ? "  ← baseline" : (r.mar > baseline.mar ? "  ✓ better" : "  ✗ worse");
  console.log(
    `  ${r.name.padEnd(38)} ${("$" + r.final.toFixed(0)).padStart(10)} ${pct(r.cagr).padStart(7)} ` +
    `${(r.maxDD * 100).toFixed(0).padStart(6)}% ${String(r.trades).padStart(7)} ${r.mar.toFixed(2).padStart(6)}${tag}`
  );
}

const best = rows[0];
console.log("\n── READ ──────────────────────────────────────────────────────────────────────");
console.log(`  Best risk-adjusted (MAR): ${best.name}`);
console.log(`    ${pct(best.cagr)}/yr at ${(best.maxDD * 100).toFixed(0)}% max drawdown  (baseline: ${pct(baseline.cagr)}/yr at ${(baseline.maxDD * 100).toFixed(0)}%)`);
console.log(`  MAR > baseline = the change earns more return per unit of drawdown, out-of-sample.`);
console.log(`  Watch 'Trades': a variant with very few OOS trades is fragile regardless of return.`);
console.log("═══════════════════════════════════════════════════════════════════════════════\n");
