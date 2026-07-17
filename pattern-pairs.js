/**
 * pattern-pairs.js — exhaustive pattern-pair search.
 *
 * For every ordered pair (A, B): candles where B fires AND A fired within the
 * preceding `window` candles (same candle allowed for distinct ids). Scores a
 * long trade (enter next open, hold 3, no stop, fees off — raw signal quality)
 * against B-alone, so you see what A adds to B.
 *
 * Ranks by z-score of "pair avg return vs B-alone avg return" and prints the
 * top/bottom results. With ~500 pairs tested, a handful of |z| ~ 2 results are
 * EXPECTED by chance — treat anything below |z| 3 as a lead, not a fact.
 *
 * Usage: node pattern-pairs.js [csv] [--window 3] [--hold 3] [--min 30]
 */

import { readFileSync } from "fs";
import { buildContext, PATTERNS, MIN_HISTORY } from "./patterns.js";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? parseInt(args[i + 1], 10) : dflt;
};
const WINDOW = opt("window", 3), HOLD = opt("hold", 3), MIN_N = opt("min", 30);
const optIdxs = new Set(["window", "hold", "min"].map((n) => args.indexOf(`--${n}`) + 1).filter((i) => i > 0));
const file = args.find((a, i) => !a.startsWith("--") && !optIdxs.has(i)) || "btc-daily-binance.csv";

const candles = readFileSync(file, "utf8").trim().split("\n").slice(1).map((l) => {
  const [date, open, high, low, close, volume] = l.split(",");
  return { date, open: +open, high: +high, low: +low, close: +close, volume: +volume };
});
const ctx = buildContext(candles);
const ids = Object.keys(PATTERNS);

// fired[i] = Set of pattern ids on candle i
const fired = candles.map((_, i) => {
  const s = new Set();
  if (i >= MIN_HISTORY) for (const id of ids) if (PATTERNS[id].detect(ctx, i)) s.add(id);
  return s;
});

// forward return of a long entered at next open, exit close after HOLD candles
const fwd = candles.map((_, i) => {
  if (i + 1 + HOLD >= candles.length) return null;
  return (candles[i + HOLD].close - candles[i + 1].open) / candles[i + 1].open;
});

// A "pairs with" B at candle i if A fired on i itself (co-occurrence) or in the
// WINDOW candles before it (sequence).
const firedRecently = (a, i) => {
  for (let j = Math.max(0, i - WINDOW); j <= i; j++) if (fired[j].has(a)) return true;
  return false;
};

function stats(rets) {
  const n = rets.length;
  if (!n) return { n: 0 };
  const mean = rets.reduce((s, r) => s + r, 0) / n;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1 || 1));
  const wins = rets.filter((r) => r > 0).length;
  return { n, mean, sd, win: wins / n };
}

// Welch z for difference of means
const welch = (a, b) =>
  a.n && b.n && (a.sd || b.sd)
    ? (a.mean - b.mean) / Math.sqrt((a.sd ** 2) / a.n + (b.sd ** 2) / b.n)
    : 0;

const results = [];
for (const b of ids) {
  const bIdx = [];
  for (let i = MIN_HISTORY; i < candles.length; i++) if (fired[i].has(b) && fwd[i] !== null) bIdx.push(i);
  if (bIdx.length < MIN_N * 2) continue;

  for (const a of ids) {
    if (a === b) continue;
    const withA = [], withoutA = [];
    for (const i of bIdx) (firedRecently(a, i) ? withA : withoutA).push(fwd[i]);
    if (withA.length < MIN_N || withoutA.length < MIN_N) continue;
    const sW = stats(withA), sO = stats(withoutA);
    results.push({ a, b, z: welch(sW, sO), sW, sO });
  }
}

results.sort((x, y) => y.z - x.z);
const fmt = (r) =>
  `${(r.a + "  ->  " + r.b).padEnd(52)} n=${String(r.sW.n).padStart(4)} | pair: win ${(r.sW.win * 100).toFixed(0)}% avg ${(r.sW.mean * 100).toFixed(2).padStart(6)}% | ` +
  `alone(n=${r.sO.n}): win ${(r.sO.win * 100).toFixed(0)}% avg ${(r.sO.mean * 100).toFixed(2).padStart(6)}% | z ${r.z.toFixed(1).padStart(5)}`;

console.log(`File: ${file} | A within ${WINDOW} candles before/at B | long next open, hold ${HOLD}, no fees | min ${MIN_N} samples`);
console.log(`Pairs tested: ${results.length} (expect ~${Math.round(results.length * 0.05)} |z|>=2 by chance alone)\n`);
console.log(`=== TOP 15: A makes B BETTER (bullish stack) ===`);
for (const r of results.slice(0, 15)) console.log(fmt(r));
console.log(`\n=== BOTTOM 15: A makes B WORSE (use A as a veto on B) ===`);
for (const r of results.slice(-15).reverse()) console.log(fmt(r));
