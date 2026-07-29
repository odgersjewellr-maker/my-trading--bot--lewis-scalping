/**
 * Heikin Ashi + SuperTrend — "Pro Colour" variant backtest.
 *
 * The sharpened strategy (see docs/heiken-ashi-supertrend-pro.md):
 *   REGIME GATE (long-only) — SuperTrend bullish AND close > EMA200 AND EMA50 > EMA200
 *   ENTRY  — first green Heikin-Ashi candle inside the regime
 *   EXIT   — first red HA candle, OR regime break, OR the 2×ATR hard-stop
 *   SIZING — risk-based: each trade risks a fixed % of equity to the ATR stop
 *
 * Usage: node backtest-hast-pro.js [csv-path]
 *
 * Prints: the pro config vs the simple HA+ST reference, a position-sizing
 * ladder, an exit-overlay comparison (why the simple colour exit wins), and
 * the out-of-sample era + train/test validation.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

const csvPath = process.argv.filter((a) => !a.startsWith("--"))[2] || "btc-daily-binance.csv";
const candles = readFileSync(resolve(csvPath), "utf8").trim().split("\n").slice(1)
  .map((l) => { const [d, o, h, lo, c, v] = l.split(","); return { date: d.trim(), open: +o, high: +h, low: +lo, close: +c, volume: +v }; })
  .filter((c) => !isNaN(c.close));
const N = candles.length;

// ─── Indicators ─────────────────────────────────────────────────────────────

function calcATRSeries(c, p) {
  const n = c.length, tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i-1].close), Math.abs(c[i].low - c[i-1].close));
  const atr = new Array(n).fill(null); if (n <= p) return atr;
  let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; atr[p] = s / p;
  for (let i = p + 1; i < n; i++) atr[i] = (atr[i-1] * (p-1) + tr[i]) / p;
  return atr;
}
function calcEMASeries(v, p) {
  const k = 2 / (p + 1), out = new Array(v.length).fill(null); let e = null;
  for (let i = 0; i < v.length; i++) { if (v[i] == null) continue; e = e == null ? v[i] : v[i]*k + e*(1-k); out[i] = e; }
  return out;
}
function calcHeikinAshi(c) {
  const n = c.length, ha = new Array(n); let po = null, pc = null;
  for (let i = 0; i < n; i++) {
    const haClose = (c[i].open + c[i].high + c[i].low + c[i].close) / 4;
    const haOpen = po == null ? (c[i].open + c[i].close) / 2 : (po + pc) / 2;
    ha[i] = { haOpen, haClose }; po = haOpen; pc = haClose;
  }
  return ha;
}
function calcSuperTrend(c, p, m) {
  const n = c.length, atr = calcATRSeries(c, p), fu = new Array(n).fill(null), fl = new Array(n).fill(null), dir = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (atr[i] == null) { dir[i] = 1; continue; }
    const hl2 = (c[i].high + c[i].low) / 2, bu = hl2 + m*atr[i], bl = hl2 - m*atr[i];
    fu[i] = (fu[i-1] == null || bu < fu[i-1] || c[i-1].close > fu[i-1]) ? bu : fu[i-1];
    fl[i] = (fl[i-1] == null || bl > fl[i-1] || c[i-1].close < fl[i-1]) ? bl : fl[i-1];
    const pd = dir[i-1] || 1;
    dir[i] = pd === 1 ? (c[i].close < fl[i] ? -1 : 1) : (c[i].close > fu[i] ? 1 : -1);
  }
  return { dir, atr };
}

const ha = calcHeikinAshi(candles);
const atr = calcATRSeries(candles, 10);
const ema200 = calcEMASeries(candles.map((c) => c.close), 200);
const ema50 = calcEMASeries(candles.map((c) => c.close), 50);
const { dir } = calcSuperTrend(candles, 10, 3.0);
const greenRun = new Array(N).fill(0), redRun = new Array(N).fill(0);
for (let i = 0; i < N; i++) {
  const g = ha[i].haClose > ha[i].haOpen, r = ha[i].haClose < ha[i].haOpen;
  greenRun[i] = g ? (i ? greenRun[i-1] : 0) + 1 : 0;
  redRun[i]   = r ? (i ? redRun[i-1]   : 0) + 1 : 0;
}
// long allowed only inside a confirmed up-regime
const regimeLong = (i) => dir[i] === 1 && ema200[i] != null && candles[i].close > ema200[i] && ema50[i] > ema200[i];

// ─── Backtest engine (windowed; fresh $1000 within [s, e]) ───────────────────

const STOP_ATR = 2.0; // initial stop distance = 1R

function runPro(cfg, s = 1, e = N - 1) {
  let portfolio = 1000, pos = null;
  const trades = [], equity = [portfolio];
  for (let i = Math.max(1, s); i <= e; i++) {
    const price = candles[i].close, a = atr[i];
    const flipBear = dir[i] === -1 && dir[i-1] === 1;

    if (pos) {
      pos.hh = Math.max(pos.hh, candles[i].high);
      if (cfg.trail)               pos.stop = Math.max(pos.stop, pos.hh - cfg.trailMult * a);
      if (cfg.beR && !pos.be && candles[i].high >= pos.entry + cfg.beR * pos.R) { pos.stop = Math.max(pos.stop, pos.entry); pos.be = true; }
      if (cfg.scaleR && !pos.partial && candles[i].high >= pos.entry + cfg.scaleR * pos.R) {
        const tgt = pos.entry + cfg.scaleR * pos.R, q = pos.qty * cfg.scaleFrac, d = (tgt - pos.entry) * q;
        portfolio += d; pos.pnlAcc += d; pos.qty -= q; pos.partial = true;
      }
      if (candles[i].low <= pos.stop) { const d = (pos.stop - pos.entry) * pos.qty; portfolio += d; pos.pnlAcc += d; trades.push({ pnl: pos.pnlAcc }); pos = null; }
    }
    if (pos) {
      const colourExit = cfg.colourExit && redRun[i] >= 1;
      if (colourExit || flipBear || !regimeLong(i)) { const d = (price - pos.entry) * pos.qty; portfolio += d; pos.pnlAcc += d; trades.push({ pnl: pos.pnlAcc }); pos = null; }
    }
    if (!pos && greenRun[i] >= 1 && regimeLong(i)) {
      const stopDist = STOP_ATR * a;
      let qty = cfg.sizeMode === "risk" ? (portfolio * cfg.riskPct) / stopDist : (portfolio * 0.80) / price;
      if (qty * price > portfolio) qty = portfolio / price; // spot: no leverage
      pos = { entry: price, qty, stop: price - stopDist, R: stopDist, hh: candles[i].high, be: false, partial: false, pnlAcc: 0 };
    }
    equity.push(portfolio + (pos ? (price - pos.entry) * pos.qty : 0));
  }
  if (pos) { const price = candles[e].close, d = (price - pos.entry) * pos.qty; portfolio += d; pos.pnlAcc += d; trades.push({ pnl: pos.pnlAcc }); }
  return stats(portfolio, trades, equity);
}

// Reference: simple HA+ST dual-EMA (flip entry, ST-flip exit, both sides, 80% equity)
function runRef(s = 1, e = N - 1, longOnly = false) {
  let portfolio = 1000, pos = null; const trades = [], equity = [portfolio];
  for (let i = Math.max(1, s); i <= e; i++) {
    const price = candles[i].close, a = atr[i];
    const flipBull = dir[i] === 1 && dir[i-1] === -1, flipBear = dir[i] === -1 && dir[i-1] === 1;
    const haGreen = ha[i].haClose > ha[i].haOpen, haRed = ha[i].haClose < ha[i].haOpen;
    const longSig  = flipBull && haGreen && candles[i].close > ema200[i] && ema50[i] > ema200[i];
    const shortSig = !longOnly && flipBear && haRed && candles[i].close < ema200[i] && ema50[i] < ema200[i];
    if (pos) { const stop = pos.side === "long" ? pos.entry - 2*pos.atr : pos.entry + 2*pos.atr;
      if (pos.side === "long" ? candles[i].low <= stop : candles[i].high >= stop) { const d = (pos.side === "long" ? (stop - pos.entry) : (pos.entry - stop)) * pos.qty; portfolio += d; trades.push({ pnl: d }); pos = null; } }
    if (pos && ((pos.side === "long" && flipBear) || (pos.side === "short" && flipBull))) { const d = (pos.side === "long" ? (price - pos.entry) : (pos.entry - price)) * pos.qty; portfolio += d; trades.push({ pnl: d }); pos = null; }
    if (!pos && (longSig || shortSig)) { const side = longSig ? "long" : "short"; pos = { side, entry: price, qty: (portfolio*0.80)/price, atr: a }; }
    equity.push(portfolio + (pos ? (pos.side === "long" ? (price - pos.entry) : (pos.entry - price)) * pos.qty : 0));
  }
  if (pos) { const price = candles[e].close, d = (pos.side === "long" ? (price - pos.entry) : (pos.entry - price)) * pos.qty; portfolio += d; trades.push({ pnl: d }); }
  return stats(portfolio, trades, equity);
}

function stats(portfolio, trades, equity) {
  const net = trades.map((t) => t.pnl), wins = net.filter((p) => p > 0), losses = net.filter((p) => p <= 0);
  const wr = net.length ? wins.length / net.length * 100 : 0;
  const pf = losses.length && losses.reduce((s, p) => s + Math.abs(p), 0) > 0 ? wins.reduce((s, p) => s + p, 0) / Math.abs(losses.reduce((s, p) => s + p, 0)) : Infinity;
  let peak = equity[0], dd = 0; for (const v of equity) { if (v > peak) peak = v; const d = (peak - v) / peak * 100; if (d > dd) dd = d; }
  const rets = equity.slice(1).map((v, i) => (v - equity[i]) / equity[i]);
  const mr = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mr) ** 2, 0) / rets.length);
  const sharpe = sd > 0 ? mr / sd * Math.sqrt(365) : 0;
  const ret = (portfolio - 1000) / 10;
  return { ret, trades: net.length, wr, pf, dd, sharpe, mar: dd > 0 ? ret / dd : 0 };
}

// ─── Output ──────────────────────────────────────────────────────────────────

const PRO = { sizeMode: "risk", riskPct: 0.05, colourExit: true, trail: false, trailMult: 3, beR: 0, scaleR: 0, scaleFrac: 0.5 };
const fmt = (r) => (r.ret.toFixed(1)+"%").padStart(9) + String(r.trades).padStart(7) + (r.wr.toFixed(1)).padStart(7) + (r.pf === Infinity ? "∞" : r.pf.toFixed(2)).padStart(7) + (r.dd.toFixed(1)+"%").padStart(8) + r.sharpe.toFixed(2).padStart(8) + (r.mar ? r.mar.toFixed(1) : "").padStart(8);
const head = "  " + "Config".padEnd(30) + "Return".padStart(9) + "Trades".padStart(7) + "Win%".padStart(7) + "PF".padStart(7) + "MaxDD".padStart(8) + "Sharpe".padStart(8) + "Ret/DD".padStart(8);

console.log("\n═══════════════════════════════════════════════════════════════════════");
console.log("  Heikin Ashi + SuperTrend — PRO COLOUR variant  |  Daily BTC/USD");
console.log("═══════════════════════════════════════════════════════════════════════");
console.log(`  ${candles.length} bars  |  ${candles[0].date} → ${candles[N-1].date}\n`);

console.log("── Pro colour vs the simple HA+ST reference ─────────────────────────");
console.log(head + "\n  " + "─".repeat(80));
console.log("  " + "PRO colour (risk 5%)".padEnd(30) + fmt(runPro(PRO)));
console.log("  " + "REF HA+ST dual-EMA (both)".padEnd(30) + fmt(runRef()));
console.log("  " + "REF HA+ST dual-EMA (long)".padEnd(30) + fmt(runRef(1, N-1, true)));

console.log("\n── Position sizing ladder (colour exit) ─────────────────────────────");
console.log(head + "\n  " + "─".repeat(80));
console.log("  " + "Blunt 80% equity".padEnd(30) + fmt(runPro({ ...PRO, sizeMode: "equity" })));
for (const rp of [0.01, 0.02, 0.03, 0.05]) console.log("  " + `Risk ${(rp*100).toFixed(0)}% per trade`.padEnd(30) + fmt(runPro({ ...PRO, riskPct: rp })));

console.log("\n── Exit overlays — why the simple colour exit wins (risk 5%) ────────");
console.log(head + "\n  " + "─".repeat(80));
console.log("  " + "Colour exit (chosen)".padEnd(30) + fmt(runPro(PRO)));
console.log("  " + "+ breakeven stop @1R".padEnd(30) + fmt(runPro({ ...PRO, beR: 1 })));
console.log("  " + "chandelier trail (3ATR)".padEnd(30) + fmt(runPro({ ...PRO, colourExit: false, trail: true })));
console.log("  " + "scale 50%@2R + trail".padEnd(30) + fmt(runPro({ ...PRO, colourExit: false, trail: true, scaleR: 2 })));

// ─── Out-of-sample ────────────────────────────────────────────────────────────

const idxAfter = (d) => { const i = candles.findIndex((c) => c.date >= d); return i < 1 ? 1 : i; };
const periods = [
  ["FULL 2018-2026", 1, N-1],
  ["'20-'21 bull",   idxAfter("2020-01-01"), idxAfter("2022-01-01")-1],
  ["'22-'23 bear",   idxAfter("2022-01-01"), idxAfter("2024-01-01")-1],
  ["'24-'26 recent", idxAfter("2024-01-01"), N-1],
];
const cell = (r) => (r.ret.toFixed(0)+"%").padStart(7) + (r.wr.toFixed(0)+"%").padStart(6) + (r.pf === Infinity ? "∞" : r.pf.toFixed(2)).padStart(6) + r.sharpe.toFixed(2).padStart(6) + ("("+r.trades+")").padStart(6);

console.log("\n── OUT-OF-SAMPLE: era-by-era (fresh $1000 per window) ───────────────");
console.log("  Each cell: Return Win% PF Sharpe (trades)\n");
console.log("  " + "Period".padEnd(16) + "│" + "  PRO colour".padEnd(31) + "│" + "  REF HA+ST dual");
console.log("  " + "─".repeat(74));
for (const [label, s, e] of periods) console.log("  " + label.padEnd(16) + "│" + cell(runPro(PRO, s, e)) + "  │" + cell(runRef(s, e)));

const split = idxAfter("2023-07-01");
console.log("\n── TRAIN/TEST holdout (split 2023-07-01) ────────────────────────────");
console.log("  " + "Window".padEnd(16) + "│" + "  PRO colour".padEnd(31) + "│" + "  REF HA+ST dual");
console.log("  " + "─".repeat(74));
console.log("  " + "TRAIN →2023.5".padEnd(16) + "│" + cell(runPro(PRO, 1, split-1)) + "  │" + cell(runRef(1, split-1)));
console.log("  " + "TEST  2023.5→".padEnd(16) + "│" + cell(runPro(PRO, split, N-1)) + "  │" + cell(runRef(split, N-1)));
console.log("\n  Note: risk-% sizing sets absolute return; the edge lives in PF/Sharpe/Win%.");
console.log("═══════════════════════════════════════════════════════════════════════\n");
