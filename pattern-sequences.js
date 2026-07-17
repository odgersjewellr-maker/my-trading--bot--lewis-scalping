/**
 * pattern-sequences.js — do recurring ORDERED pattern chains (A → B → C)
 * carry information, and does the order itself matter?
 *
 * A sequence fires on candle i when: C fires on i, B fired on some candle in
 * the 3 candles before i, and A fired in the 3 candles before that B. Each
 * sequence is counted once per trigger candle and scored by the forward
 * return of a long entered at the next open and held 3 candles (no fees —
 * raw signal quality).
 *
 * Honesty: 70/30 chronological split. Sequences are ranked on TRAIN; the
 * TEST columns are the verdict. With hundreds of sequences tested, expect
 * several |z|>=2 flukes — trust direction agreement, not lone stars.
 *
 * The second section takes the top sets and prints ALL orderings of the
 * same three patterns side by side, answering "does 21,13,4 differ from
 * 4,13,21?" directly.
 *
 * Usage: node pattern-sequences.js [csv] [--step 3] [--hold 3] [--min 40]
 */

import { readFileSync } from "fs";
import { buildContext, PATTERNS, MIN_HISTORY } from "./patterns.js";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? parseInt(args[i + 1], 10) : dflt;
};
const STEP = opt("step", 3), HOLD = opt("hold", 3), MIN_N = opt("min", 40);
const optIdxs = new Set(["step", "hold", "min"].map((n) => args.indexOf(`--${n}`) + 1).filter((i) => i > 0));
const file = args.find((a, i) => !a.startsWith("--") && !optIdxs.has(i)) || "btc-daily-binance.csv";

const candles = readFileSync(file, "utf8").trim().split("\n").slice(1).map((l) => {
  const [date, open, high, low, close, volume] = l.split(",");
  return { date, open: +open, high: +high, low: +low, close: +close, volume: +volume };
});
const ctx = buildContext(candles);

// patterns with enough occurrences to chain three deep
const counts = {};
const fired = candles.map((_, i) => {
  const s = [];
  if (i >= MIN_HISTORY) for (const id of Object.keys(PATTERNS)) {
    if (PATTERNS[id].detect(ctx, i)) { s.push(id); counts[id] = (counts[id] ?? 0) + 1; }
  }
  return s;
});
const cand = new Set(Object.keys(counts).filter((id) => counts[id] >= 100));

// union of candidate patterns fired in the STEP candles before candle j
const prevUnion = candles.map((_, j) => {
  const s = new Set();
  for (let k = Math.max(0, j - STEP); k < j; k++) for (const id of fired[k]) if (cand.has(id)) s.add(id);
  return s;
});

const fwd = candles.map((_, i) =>
  i + 1 + HOLD < candles.length ? (candles[i + HOLD].close - candles[i + 1].open) / candles[i + 1].open : null);
const cut = Math.floor(candles.length * 0.7);

// accumulate per-sequence stats: n, sum, sumsq per train/test bucket
const seqs = new Map();
const bump = (key, ret, isTrain) => {
  let s = seqs.get(key);
  if (!s) { s = { tr: [0, 0, 0], te: [0, 0, 0] }; seqs.set(key, s); }
  const b = isTrain ? s.tr : s.te;
  b[0]++; b[1] += ret; b[2] += ret * ret;
};

const baseTr = [0, 0, 0], baseTe = [0, 0, 0];
for (let i = MIN_HISTORY; i < candles.length; i++) {
  if (fwd[i] === null) continue;
  const isTrain = i < cut;
  const b = isTrain ? baseTr : baseTe;
  b[0]++; b[1] += fwd[i]; b[2] += fwd[i] * fwd[i];

  const seen = new Set();
  for (const C of fired[i]) {
    if (!cand.has(C)) continue;
    for (let j = Math.max(0, i - STEP); j < i; j++) {
      for (const B of fired[j]) {
        if (!cand.has(B)) continue;
        for (const A of prevUnion[j]) {
          const key = `${A} > ${B} > ${C}`;
          if (seen.has(key)) continue;
          seen.add(key);
          bump(key, fwd[i], isTrain);
        }
      }
    }
  }
}

const stats = ([n, sum, sumsq]) => {
  if (!n) return { n: 0, mean: 0, sd: 0 };
  const mean = sum / n;
  return { n, mean, sd: Math.sqrt(Math.max(0, sumsq / n - mean * mean)) };
};
const zVs = (s, base) =>
  s.n && base.n ? (s.mean - base.mean) / Math.sqrt((s.sd ** 2) / s.n + (base.sd ** 2) / base.n) : 0;

const bTr = stats(baseTr), bTe = stats(baseTe);
const rows = [];
for (const [key, s] of seqs) {
  const tr = stats(s.tr), te = stats(s.te);
  if (tr.n < MIN_N || te.n < 15) continue;
  rows.push({ key, tr, te, zTr: zVs(tr, bTr), zTe: zVs(te, bTe) });
}
rows.sort((a, b) => b.zTr - a.zTr);

const fmt = (r) => {
  const held = Math.sign(r.te.mean - bTe.mean) === Math.sign(r.tr.mean - bTr.mean) ? "HELD " : "BROKE";
  return `${r.key.padEnd(64)} train n=${String(r.tr.n).padStart(4)} avg ${(r.tr.mean * 100).toFixed(2).padStart(6)}% z ${r.zTr.toFixed(1).padStart(4)} | ` +
    `test n=${String(r.te.n).padStart(3)} avg ${(r.te.mean * 100).toFixed(2).padStart(6)}% [${held}]`;
};

console.log(`File: ${file} | chain step <= ${STEP} candles | hold ${HOLD} | ${seqs.size} sequences seen, ${rows.length} with n >= ${MIN_N}`);
console.log(`Baseline train avg ${(bTr.mean * 100).toFixed(2)}% | test avg ${(bTe.mean * 100).toFixed(2)}%\n`);

console.log("=== TOP 12 SEQUENCES (by train z) ===");
for (const r of rows.slice(0, 12)) console.log(fmt(r));
console.log("\n=== BOTTOM 8 (avoid / veto candidates) ===");
for (const r of rows.slice(-8).reverse()) console.log(fmt(r));

// ── does ORDER matter? all permutations of the top sets, side by side ────────
console.log("\n=== ORDER SENSITIVITY: same three patterns, every sequence ===");
const shown = new Set();
let setsShown = 0;
for (const r of rows) {
  const parts = r.key.split(" > ");
  if (new Set(parts).size !== 3) continue; // need three distinct patterns
  const setKey = [...parts].sort().join("+");
  if (shown.has(setKey)) continue;
  shown.add(setKey);
  if (++setsShown > 3) break;
  console.log(`\nSet: {${[...parts].sort().join(", ")}}`);
  const perms = [];
  const permute = (arr, cur = []) => {
    if (!arr.length) { perms.push(cur); return; }
    arr.forEach((x, idx) => permute(arr.filter((_, k) => k !== idx), [...cur, x]));
  };
  permute([...new Set(parts)]);
  for (const p of perms) {
    const key = p.join(" > ");
    const s = seqs.get(key);
    if (!s) { console.log(`  ${key.padEnd(62)} never occurs`); continue; }
    const tr = stats(s.tr), te = stats(s.te);
    console.log(`  ${key.padEnd(62)} train n=${String(tr.n).padStart(4)} avg ${(tr.mean * 100).toFixed(2).padStart(6)}% | test n=${String(te.n).padStart(3)} avg ${(te.mean * 100).toFixed(2).padStart(6)}%`);
  }
}
