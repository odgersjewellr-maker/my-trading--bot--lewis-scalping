/**
 * pattern-mine.js — decision-tree combination miner with out-of-sample test.
 *
 * Treats every pattern in patterns.js (plus a volatility-regime flag) as a
 * boolean feature on each candle and greedily grows a shallow decision tree
 * that splits candles by forward 3-candle return. The tree is trained ONLY on
 * the first 70% of history; every discovered combination is then re-scored on
 * the untouched last 30%. Combinations whose edge survives the test window
 * are the ones worth considering — everything else was curve-fitting.
 *
 * Usage: node pattern-mine.js [csv] [--hold 3] [--depth 3] [--split 0.7]
 */

import { readFileSync } from "fs";
import { buildContext, PATTERNS, MIN_HISTORY } from "./patterns.js";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? parseFloat(args[i + 1]) : dflt;
};
const HOLD = opt("hold", 3), DEPTH = opt("depth", 3), SPLIT = opt("split", 0.7);
const optIdxs = new Set(["hold", "depth", "split"].map((n) => args.indexOf(`--${n}`) + 1).filter((i) => i > 0));
const file = args.find((a, i) => !a.startsWith("--") && !optIdxs.has(i)) || "btc-daily-binance.csv";

const candles = readFileSync(file, "utf8").trim().split("\n").slice(1).map((l) => {
  const [date, open, high, low, close, volume] = l.split(",");
  return { date, open: +open, high: +high, low: +low, close: +close, volume: +volume };
});
const ctx = buildContext(candles);

// ── features ─────────────────────────────────────────────────────────────────
// every library pattern is a boolean feature (includes the volatility-regime
// context patterns, which are causal rolling percentiles — no lookahead)
const featIds = Object.keys(PATTERNS);

// rows: [features(bool[]), forward return]
const rows = [];
for (let i = MIN_HISTORY; i < candles.length - HOLD - 1; i++) {
  const f = featIds.map((id) => PATTERNS[id].detect(ctx, i));
  const ret = (candles[i + HOLD].close - candles[i + 1].open) / candles[i + 1].open;
  rows.push({ f, ret, date: candles[i].date });
}
const cut = Math.floor(rows.length * SPLIT);
const train = rows.slice(0, cut), test = rows.slice(cut);

// ── greedy tree ──────────────────────────────────────────────────────────────
const MIN_LEAF = 80;
const mean = (rs) => rs.reduce((s, r) => s + r.ret, 0) / (rs.length || 1);
const sd = (rs, m) => Math.sqrt(rs.reduce((s, r) => s + (r.ret - m) ** 2, 0) / (rs.length - 1 || 1));

// Welch t-stat between the two sides of a split — prefer robust splits over big ones
function splitScore(a, b) {
  if (a.length < MIN_LEAF || b.length < MIN_LEAF) return 0;
  const ma = mean(a), mb = mean(b);
  return Math.abs(ma - mb) / Math.sqrt(sd(a, ma) ** 2 / a.length + sd(b, mb) ** 2 / b.length);
}

function grow(rs, depth, path) {
  if (depth === 0 || rs.length < MIN_LEAF * 2) return { leaf: true, path, rows: rs };
  let best = null;
  for (let fi = 0; fi < featIds.length; fi++) {
    if (path.some((p) => p.fi === fi)) continue;
    const yes = rs.filter((r) => r.f[fi]), no = rs.filter((r) => !r.f[fi]);
    const score = splitScore(yes, no);
    if (score > 1.8 && (!best || score > best.score)) best = { fi, yes, no, score };
  }
  if (!best) return { leaf: true, path, rows: rs };
  return {
    leaf: false, fi: best.fi,
    yes: grow(best.yes, depth - 1, [...path, { fi: best.fi, val: true }]),
    no: grow(best.no, depth - 1, [...path, { fi: best.fi, val: false }]),
  };
}

const tree = grow(train, DEPTH, []);

// collect leaves, score each path on train and test
const leaves = [];
(function walk(node) {
  if (node.leaf) { leaves.push(node); return; }
  walk(node.yes); walk(node.no);
})(tree);

const matches = (r, path) => path.every((p) => r.f[p.fi] === p.val);
const describe = (path) =>
  path.length ? path.map((p) => (p.val ? "" : "NOT ") + featIds[p.fi]).join(" AND ") : "(everything)";

function scoreSet(rs) {
  if (!rs.length) return { n: 0, win: 0, avg: 0 };
  const wins = rs.filter((r) => r.ret > 0).length;
  return { n: rs.length, win: wins / rs.length, avg: mean(rs) };
}

console.log(`File: ${file} | hold ${HOLD} | depth ${DEPTH} | features: ${featIds.length}`);
console.log(`Train: ${train.length} candles (${train[0].date} -> ${train[train.length - 1].date})`);
console.log(`Test:  ${test.length} candles (${test[0].date} -> ${test[test.length - 1].date}) — NEVER seen during mining\n`);

const trainBase = scoreSet(train), testBase = scoreSet(test);
console.log(`Baseline train: win ${(trainBase.win * 100).toFixed(1)}%, avg ${(trainBase.avg * 100).toFixed(2)}%`);
console.log(`Baseline test:  win ${(testBase.win * 100).toFixed(1)}%, avg ${(testBase.avg * 100).toFixed(2)}%\n`);

const scored = leaves.map((l) => {
  const tr = scoreSet(l.rows);
  const te = scoreSet(test.filter((r) => matches(r, l.path)));
  return { desc: describe(l.path), tr, te, edge: tr.avg - trainBase.avg };
}).sort((a, b) => b.edge - a.edge);

console.log("=== DISCOVERED COMBINATIONS (sorted by train edge; judge them by the TEST columns) ===");
for (const s of scored) {
  const held = s.te.n >= 20 && Math.sign(s.te.avg - testBase.avg) === Math.sign(s.edge) ? "HELD " : s.te.n < 20 ? "n/a  " : "BROKE";
  console.log(`\n${s.desc}`);
  console.log(`  train: n=${s.tr.n}  win ${(s.tr.win * 100).toFixed(1)}%  avg ${(s.tr.avg * 100).toFixed(2)}%   | ` +
    `test: n=${s.te.n}  win ${(s.te.win * 100).toFixed(1)}%  avg ${(s.te.avg * 100).toFixed(2)}%   [${held}]`);
}
console.log(`\nHELD  = test-window edge points the same way as the train edge (n>=20)`);
console.log(`BROKE = the combination's edge reversed on unseen data — it was curve-fitting`);
