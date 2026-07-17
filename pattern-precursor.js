/**
 * pattern-precursor.js — do earlier patterns predict whether a signal wins?
 *
 * Takes every trade the rule engine (pattern-rules.json) would have made,
 * then looks BACKWARD from each signal candle: which patterns fired in the
 * N candles before the signal? For each candidate precursor it compares the
 * win rate of trades WITH that precursor vs WITHOUT it, with a two-proportion
 * z-test so small-sample flukes are flagged instead of trusted.
 *
 * Usage: node pattern-precursor.js [csv-file] [--window N]   (default window 3)
 */

import { readFileSync } from "fs";
import { buildContext, PATTERNS } from "./patterns.js";
import { backtest } from "./pattern-backtest.js";

const args = process.argv.slice(2);
const wIdx = args.indexOf("--window");
const WINDOW = wIdx >= 0 ? parseInt(args[wIdx + 1], 10) : 3;
const file = args.find((a, i) => !a.startsWith("--") && i !== wIdx + 1) || "btc-daily-binance.csv";

const candles = readFileSync(file, "utf8").trim().split("\n").slice(1).map((l) => {
  const [date, open, high, low, close, volume] = l.split(",");
  return { date, open: +open, high: +high, low: +low, close: +close, volume: +volume };
});
const config = JSON.parse(readFileSync("pattern-rules.json", "utf8"));
const ctx = buildContext(candles);
const trades = backtest(candles, config);

// Precompute which patterns fired on every candle (signal candle excluded from window).
const firedAt = candles.map((_, i) => {
  const s = new Set();
  if (i >= 4) for (const [id, p] of Object.entries(PATTERNS)) if (p.detect(ctx, i)) s.add(id);
  return s;
});

const precursorFired = (t, id) => {
  for (let j = Math.max(0, t.signalIdx - WINDOW); j < t.signalIdx; j++) {
    if (firedAt[j].has(id)) return true;
  }
  return false;
};

// Two-proportion z-test: is winWith really different from winWithout?
function zTest(w1, n1, w2, n2) {
  if (!n1 || !n2) return 0;
  const p1 = w1 / n1, p2 = w2 / n2, p = (w1 + w2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se ? (p1 - p2) / se : 0;
}

function analyze(tradeSet, label) {
  const baseWins = tradeSet.filter((t) => t.netPct > 0).length;
  console.log(`\n=== ${label}: ${tradeSet.length} trades, base win rate ${((baseWins / tradeSet.length) * 100).toFixed(1)}%, avg ${(tradeSet.reduce((s, t) => s + t.netPct, 0) / tradeSet.length).toFixed(2)}% ===`);
  console.log(`Precursor fired in the ${WINDOW} candles BEFORE the signal:`);
  console.log(`${"precursor".padEnd(26)} ${"n-with".padStart(6)} ${"win-with".padStart(9)} ${"avg-with".padStart(9)} | ${"n-w/o".padStart(6)} ${"win-w/o".padStart(8)} ${"avg-w/o".padStart(8)} | lift    z`);

  const rows = [];
  for (const id of Object.keys(PATTERNS)) {
    const withP = tradeSet.filter((t) => precursorFired(t, id));
    const without = tradeSet.filter((t) => !precursorFired(t, id));
    if (withP.length < 10 || without.length < 10) continue; // nothing to learn
    const wW = withP.filter((t) => t.netPct > 0).length;
    const wO = without.filter((t) => t.netPct > 0).length;
    const avgW = withP.reduce((s, t) => s + t.netPct, 0) / withP.length;
    const avgO = without.reduce((s, t) => s + t.netPct, 0) / without.length;
    const z = zTest(wW, withP.length, wO, without.length);
    rows.push({ id, nW: withP.length, winW: wW / withP.length, avgW, nO: without.length, winO: wO / without.length, avgO, z });
  }
  rows.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  for (const r of rows) {
    const sig = Math.abs(r.z) >= 2.6 ? "***" : Math.abs(r.z) >= 2 ? "*  " : "   ";
    console.log(
      `${r.id.padEnd(26)} ${String(r.nW).padStart(6)} ${((r.winW) * 100).toFixed(1).padStart(8)}% ${r.avgW.toFixed(2).padStart(8)}% | ` +
      `${String(r.nO).padStart(6)} ${((r.winO) * 100).toFixed(1).padStart(7)}% ${r.avgO.toFixed(2).padStart(7)}% | ` +
      `${(((r.winW - r.winO)) * 100).toFixed(1).padStart(5)}pp ${r.z.toFixed(1).padStart(5)} ${sig}`
    );
  }
  console.log(`Significance: *** |z|>=2.6 (solid), * |z|>=2 (suggestive), blank = likely noise.`);
  console.log(`NOTE: ~${Object.keys(PATTERNS).length} precursors tested — expect ~1 false "*" per table by pure chance.`);
}

console.log(`File: ${file} | window: ${WINDOW} candles before signal | fees included in outcomes`);
analyze(trades, "ALL RULE TRADES");

// Per-rule breakdown for rules with enough trades
const byRule = {};
for (const t of trades) (byRule[t.rule] ??= []).push(t);
for (const [rule, ts] of Object.entries(byRule)) {
  if (ts.length >= 80) analyze(ts, `RULE: ${rule}`);
}
