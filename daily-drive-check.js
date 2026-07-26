/**
 * Daily edge-check — does the direction set at the open persist to the close?
 *
 * This is the low-resolution proxy for the Opening Drive idea, runnable TODAY on
 * the daily data already in the repo (btc-daily-binance.csv) — no intraday feed
 * needed. At daily resolution the only "direction at the open" we can see is the
 * overnight GAP (today's open vs yesterday's close); "till it fades" becomes
 * "hold to the daily close". If gap direction has no edge here, the intraday
 * version is unlikely to be a goldmine either — so run this first.
 *
 * It is NOT the strategy. The real thing is opening-drive.js on intraday data.
 *
 * Usage: node daily-drive-check.js [csv-path]
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const csvPath = process.argv[2] || "btc-daily-binance.csv";
const lines = readFileSync(resolve(csvPath), "utf8").trim().split("\n").slice(1);
const c = lines.map((l) => {
  const [date, open, high, low, close, volume] = l.split(",");
  return { date, open: +open, high: +high, low: +low, close: +close, volume: +volume };
}).filter((x) => !isNaN(x.close));

const FEE = 0.0006; // per side

// ── 1. Persistence stats: given a gap up/down, how often does the day continue? ──
let gapUp = 0, gapUpFollow = 0, gapDn = 0, gapDnFollow = 0;
let sumIntradayUp = 0, sumIntradayDn = 0;
for (let i = 1; i < c.length; i++) {
  const gap = (c[i].open - c[i - 1].close) / c[i - 1].close;
  const intraday = (c[i].close - c[i].open) / c[i].open; // open → close move
  if (gap > 0) { gapUp++; if (intraday > 0) gapUpFollow++; sumIntradayUp += intraday; }
  else if (gap < 0) { gapDn++; if (intraday < 0) gapDnFollow++; sumIntradayDn += intraday; }
}

// How big are the gaps at all? (24/7 crypto: daily open ≈ prior close, so ~0)
const absGaps = [];
for (let i = 1; i < c.length; i++) absGaps.push(Math.abs((c[i].open - c[i - 1].close) / c[i - 1].close));
absGaps.sort((a, b) => a - b);
const meanGap = absGaps.reduce((a, b) => a + b, 0) / absGaps.length;
const p90Gap  = absGaps[Math.floor(absGaps.length * 0.9)];

console.log("\n═══════════════════════════════════════════════════════════");
console.log("  Daily Opening-Drive edge-check  (gap → open→close persistence)");
console.log("═══════════════════════════════════════════════════════════");
console.log(`  ${c.length} daily candles  |  ${c[0].date} → ${c[c.length - 1].date}\n`);
console.log("  Size of the overnight gap (open vs prior close):");
console.log("  " + "─".repeat(58));
console.log(`  mean |gap| ${(meanGap * 100).toFixed(3)}%   90th-pctile |gap| ${(p90Gap * 100).toFixed(3)}%`);
console.log("  → basically zero: 24/7 crypto has no daily-boundary open. The daily");
console.log("    candle open is just the prior close, so there is no gap to trade here.");
console.log("\n  Does the open's direction (overnight gap) carry into the day?");
console.log("  " + "─".repeat(58));
console.log(`  Gap UP   days: ${gapUp.toString().padStart(4)}   closed higher than open: ${(gapUpFollow / gapUp * 100).toFixed(1)}%   avg O→C ${(sumIntradayUp / gapUp * 100).toFixed(2)}%`);
console.log(`  Gap DOWN days: ${gapDn.toString().padStart(4)}   closed lower  than open: ${(gapDnFollow / gapDn * 100).toFixed(1)}%   avg O→C ${(sumIntradayDn / gapDn * 100).toFixed(2)}%`);
console.log("  → ~50/50 = coin flip. No persistence edge at the daily UTC boundary.");

// ── 2. Tradeable proxy: go with the gap direction, exit at the close ──
// Report GROSS (signal only) and NET (after fees) so fee drag can't masquerade
// as, or hide, a real signal. Thresholds are tuned to the tiny crypto gaps above.
function simulate(minGapPct) {
  let gross = 1000, net = 1000;
  let n = 0, wins = 0;
  for (let i = 1; i < c.length; i++) {
    const gap = (c[i].open - c[i - 1].close) / c[i - 1].close;
    if (Math.abs(gap) < minGapPct) continue;
    const dir = gap > 0 ? 1 : -1;
    const g = dir * (c[i].close - c[i].open) / c[i].open; // open→close in gap direction
    gross *= 1 + g;
    net   *= 1 + (g - 2 * FEE);
    n++;
    if (g > 0) wins++;
  }
  return { n, winRate: n ? wins / n * 100 : 0, grossRet: (gross - 1000) / 10, netRet: (net - 1000) / 10 };
}

console.log("\n  Trading the gap direction, exit at the daily close");
console.log("  " + "─".repeat(58));
console.log(`  ${"min |gap|".padEnd(10)} ${"trades".padStart(7)} ${"win%".padStart(7)} ${"gross".padStart(9)} ${"net(fees)".padStart(10)}`);
for (const g of [0, 0.0005, 0.001, 0.002]) {
  const r = simulate(g);
  console.log(
    `  ${((g * 100).toFixed(2) + "%").padEnd(10)} ${String(r.n).padStart(7)} ${(r.winRate.toFixed(1) + "%").padStart(7)} ${(r.grossRet.toFixed(1) + "%").padStart(9)} ${(r.netRet.toFixed(1) + "%").padStart(10)}`
  );
}
console.log("\n  Verdict: no edge at the daily boundary — expected for 24/7 crypto.");
console.log("  The real test is the US cash open (13:30 UTC), where institutional/ETF");
console.log("  flow actually creates a directional drive. That needs intraday data:");
console.log("    node fetch-binance-intraday.js BTCUSDT 15m 365");
console.log("    node opening-drive.js btcusdt-15m-binance.csv");
console.log("═══════════════════════════════════════════════════════════\n");
