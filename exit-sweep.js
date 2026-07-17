/**
 * exit-sweep.js — which exit policy squeezes the most out of our entries?
 *
 * Entries are fixed: the enabled long rules in pattern-rules.json. Each exit
 * policy below is simulated independently over the same signal stream (hard
 * 4% stop always active, fees per side, one position at a time). Trades are
 * bucketed by entry date into TRAIN (first 70% of candles) and TEST (last
 * 30%) — pick the policy on TRAIN, believe only what TEST confirms.
 *
 * Signal timing is honest: everything is decided on closed candles, and both
 * entries and signal-based exits execute at the NEXT candle's open.
 *
 * Usage: node exit-sweep.js [csv]
 */

import { readFileSync } from "fs";
import { buildContext, PATTERNS, MIN_HISTORY } from "./patterns.js";
import { evaluateRules } from "./pattern-backtest.js";

const file = process.argv[2] || "btc-daily-binance.csv";
const candles = readFileSync(file, "utf8").trim().split("\n").slice(1).map((l) => {
  const [date, open, high, low, close, volume] = l.split(",");
  return { date, open: +open, high: +high, low: +low, close: +close, volume: +volume };
});
const config = JSON.parse(readFileSync("pattern-rules.json", "utf8"));
const ctx = buildContext(candles);
const FEE = (config.settings?.fee_pct_per_side ?? 0.1) / 100;
const STOP_PCT = 4, CAP = 15;

const bearIds = Object.entries(PATTERNS).filter(([, p]) => p.dir === "bear").map(([id]) => id);
const strongBear = ["bearish_engulfing", "three_black_crows", "evening_star", "dark_cloud_cover", "outside_bar_red"];
const firesAny = (ids, i) => ids.some((id) => PATTERNS[id].detect(ctx, i));

// Exit policies: checked at each candle close j while in a trade; returning
// true exits at candle j+1's open. `hold` = candles closed since entry.
const POLICIES = {
  "timer 3 (current)":        { timer: 3 },
  "timer 5":                  { timer: 5 },
  "timer 10":                 { timer: 10 },
  "any bear pattern":         { signal: (j) => firesAny(bearIds, j) },
  "strong bear pattern":      { signal: (j) => firesAny(strongBear, j) },
  "close below prev low":     { signal: (j) => PATTERNS.close_below_prev_low.detect(ctx, j) },
  "close below EMA8":         { signal: (j) => ctx.ema8[j] !== null && candles[j].close < ctx.ema8[j] },
  "EMA8 or strong bear":      { signal: (j) => (ctx.ema8[j] !== null && candles[j].close < ctx.ema8[j]) || firesAny(strongBear, j) },
  "trailing stop 3%":         { trail: 0.03 },
  "trailing stop 5%":         { trail: 0.05 },
  "trail 5% or strong bear":  { trail: 0.05, signal: (j) => firesAny(strongBear, j) },
};

function simulate(policy) {
  const trades = [];
  let i = MIN_HISTORY;
  while (i < candles.length - 2) {
    const d = evaluateRules(ctx, i, config);
    if (!d || d.action !== "long") { i++; continue; }
    const entryIdx = i + 1, entry = candles[entryIdx].open;
    const stop = entry * (1 - STOP_PCT / 100);
    let peak = entry, exit = null, exitIdx = null, reason = null;

    for (let j = entryIdx; j < candles.length; j++) {
      const c = candles[j], hold = j - entryIdx + 1;
      // intra-candle: hard stop, then trailing stop (evaluated against this candle's low)
      const trailStop = policy.trail ? peak * (1 - policy.trail) : -Infinity;
      const level = Math.max(stop, trailStop);
      if (c.open <= level) { exit = c.open; exitIdx = j; reason = "stop"; break; }
      if (c.low <= level) { exit = level; exitIdx = j; reason = level === stop ? "stop" : "trail"; break; }
      peak = Math.max(peak, c.close);
      // close-based decisions
      if (policy.timer && hold >= policy.timer) { exit = c.close; exitIdx = j; reason = "timer"; break; }
      if (!policy.timer && hold >= CAP) { exit = c.close; exitIdx = j; reason = "cap"; break; }
      if (policy.signal && policy.signal(j)) {
        if (j + 1 >= candles.length) { exit = c.close; exitIdx = j; reason = "signal"; break; }
        exit = candles[j + 1].open; exitIdx = j + 1; reason = "signal"; break;
      }
      if (j === candles.length - 1) { exit = c.close; exitIdx = j; reason = "eod"; }
    }
    if (exit === null) break;
    const net = ((exit / entry) * (1 - FEE)) / (1 + FEE) - 1;
    trades.push({ entryIdx, netPct: net * 100, hold: exitIdx - entryIdx + 1, reason });
    i = exitIdx + 1;
  }
  return trades;
}

const cut = Math.floor(candles.length * 0.7);
function bucketStats(trades, lo, hi) {
  const ts = trades.filter((t) => t.entryIdx >= lo && t.entryIdx < hi);
  if (!ts.length) return null;
  const wins = ts.filter((t) => t.netPct > 0);
  const gw = wins.reduce((s, t) => s + t.netPct, 0);
  const gl = ts.filter((t) => t.netPct <= 0).reduce((s, t) => s - t.netPct, 0);
  let eq = 1; for (const t of ts) eq *= 1 + t.netPct / 100;
  return {
    n: ts.length, win: wins.length / ts.length, avg: ts.reduce((s, t) => s + t.netPct, 0) / ts.length,
    pf: gl ? gw / gl : Infinity, total: (eq - 1) * 100, hold: ts.reduce((s, t) => s + t.hold, 0) / ts.length,
  };
}
const f = (s) => s
  ? `n=${String(s.n).padStart(3)} win ${(s.win * 100).toFixed(0).padStart(3)}% avg ${s.avg.toFixed(2).padStart(6)}% PF ${s.pf.toFixed(2).padStart(5)} total ${s.total.toFixed(0).padStart(6)}% hold ${s.hold.toFixed(1).padStart(4)}`
  : "no trades";

console.log(`File: ${file} | entries: enabled rules in pattern-rules.json | stop ${STOP_PCT}% | fees ${FEE * 200}% round trip`);
console.log(`TRAIN = entries before ${candles[cut].date}, TEST = after (never used to pick a policy)\n`);
for (const [name, policy] of Object.entries(POLICIES)) {
  const trades = simulate(policy);
  console.log(name.padEnd(26) + "TRAIN  " + f(bucketStats(trades, 0, cut)));
  console.log("".padEnd(26) + "TEST   " + f(bucketStats(trades, cut, candles.length)) + "\n");
}
