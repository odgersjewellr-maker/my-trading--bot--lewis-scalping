/**
 * squeeze-sweep.js — three optimization experiments over the current rules,
 * each with a 70/30 train/test split. Pick on TRAIN, believe TEST.
 *
 *   A. per-rule hard-stop sweep (2% .. no stop)
 *   B. volatility-regime gates (veto entries in high- or low-vol regimes)
 *   C. scale-out exits (book part of the position at the first exit signal)
 *
 * Usage: node squeeze-sweep.js [csv]
 */

import { readFileSync } from "fs";
import { backtest } from "./pattern-backtest.js";

const file = process.argv[2] || "btc-daily-binance.csv";
const candles = readFileSync(file, "utf8").trim().split("\n").slice(1).map((l) => {
  const [date, open, high, low, close, volume] = l.split(",");
  return { date, open: +open, high: +high, low: +low, close: +close, volume: +volume };
});
const base = JSON.parse(readFileSync("pattern-rules.json", "utf8"));
const cut = Math.floor(candles.length * 0.7);

function stats(trades) {
  if (!trades.length) return null;
  const wins = trades.filter((t) => t.netPct > 0);
  const gw = wins.reduce((s, t) => s + t.netPct, 0);
  const gl = trades.filter((t) => t.netPct <= 0).reduce((s, t) => s - t.netPct, 0);
  let eq = 1; for (const t of trades) eq *= 1 + t.netPct / 100;
  return { n: trades.length, win: wins.length / trades.length, avg: trades.reduce((s, t) => s + t.netPct, 0) / trades.length, pf: gl ? gw / gl : Infinity, total: (eq - 1) * 100 };
}
const f = (s) => s ? `n=${String(s.n).padStart(3)} win ${(s.win * 100).toFixed(0).padStart(3)}% avg ${s.avg.toFixed(2).padStart(6)}% PF ${s.pf === Infinity ? "  inf" : s.pf.toFixed(2).padStart(5)} total ${s.total.toFixed(0).padStart(6)}%` : "no trades";

function run(config, { rule = null } = {}) {
  const trades = backtest(candles, config).filter((t) => !rule || t.rule === rule);
  return {
    train: stats(trades.filter((t) => t.signalIdx < cut)),
    test: stats(trades.filter((t) => t.signalIdx >= cut)),
  };
}
const line = (label, r) => console.log(label.padEnd(30) + "TRAIN " + f(r.train) + "   | TEST " + f(r.test));

console.log(`File: ${file} | split at ${candles[cut].date}\n`);
line("BASELINE (current rules)", run(base));

// ── A. per-rule stop sweep ───────────────────────────────────────────────────
console.log("\n=== A. HARD STOP SWEEP (per rule; other rules stay at their current stop) ===");
const enabled = base.rules.filter((r) => r.enabled).map((r) => r.name);
for (const name of enabled) {
  console.log(`\n-- ${name}`);
  for (const stop of [2, 3, 4, 5, 6, 8, 100]) {
    const cfg = structuredClone(base);
    cfg.rules.find((r) => r.name === name).then.stop_pct = stop;
    line(`   stop ${stop === 100 ? "none" : stop + "%"}`, run(cfg, { rule: name }));
  }
}

// ── B. volatility-regime gates ───────────────────────────────────────────────
console.log("\n=== B. REGIME GATES (applied to every enabled rule) ===");
for (const [label, veto] of [["veto high_volatility", "high_volatility"], ["veto low_volatility", "low_volatility"], ["no gate (baseline)", null]]) {
  const cfg = structuredClone(base);
  if (veto) for (const r of cfg.rules) if (r.enabled) r.if.none = [...(r.if.none ?? []), veto];
  line(label, run(cfg));
}

// ── C. scale-out exits ───────────────────────────────────────────────────────
console.log("\n=== C. SCALE-OUT (fraction booked at first exit signal, rest rides) ===");
for (const frac of [0, 0.33, 0.5, 0.67]) {
  const cfg = structuredClone(base);
  for (const r of cfg.rules) if (r.enabled && r.then.exit) r.then.exit.scale_out = frac;
  line(frac === 0 ? "full exit (baseline)" : `scale out ${Math.round(frac * 100)}%`, run(cfg));
}
