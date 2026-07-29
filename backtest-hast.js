/**
 * Heikin Ashi + SuperTrend Backtest — runs the decision-tree strategy against
 * historical daily OHLC data. Mirrors the engine/stats style of backtest.js.
 *
 * Usage: node backtest-hast.js [csv-path] [--optimize]
 *
 * Without --optimize: runs a comparison of the decision-tree variants
 *                     (raw, +EMA200 filter, +strong-wick, both) and prints a
 *                     full trade log for the recommended configuration.
 * With --optimize:    grid-searches atrPeriod, atrMult, emaLen and ranks by Sharpe.
 *
 * Strategy (see docs/heiken-ashi-supertrend-plan.md for the full decision tree):
 *   LONG  — SuperTrend flips bullish  AND Heikin-Ashi candle is green
 *   SHORT — SuperTrend flips bearish  AND Heikin-Ashi candle is red
 *   EXIT  — SuperTrend flips against the position, or the ATR hard-stop is hit
 *   Optional gates: EMA200 trend filter, "strong" HA candle (small opposing wick).
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// ─── Load CSV ─────────────────────────────────────────────────────────────────

const OPTIMIZE = process.argv.includes("--optimize");
const csvPath = process.argv.filter((a) => !a.startsWith("--"))[2] || "btc-daily-binance.csv";

const lines = readFileSync(resolve(csvPath), "utf8").trim().split("\n").slice(1); // skip header
const candles = lines
  .map((l) => {
    const [date, open, high, low, close, volume] = l.split(",");
    return {
      date: date.trim(),
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume),
    };
  })
  .filter((c) => !isNaN(c.close)); // Binance CSV is already oldest-first

// ─── Indicator helpers ────────────────────────────────────────────────────────

function calcATRSeries(candles, period) {
  const n = candles.length;
  const tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  const atr = new Array(n).fill(null);
  if (n <= period) return atr;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  return atr;
}

function calcEMASeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let ema = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    ema = ema == null ? v : v * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

// Heikin-Ashi candles derived from the raw OHLC series.
// haClose = ohlc4, haOpen = smoothed prior HA body, haHigh/haLow clamp to real range.
function calcHeikinAshi(candles) {
  const n = candles.length;
  const ha = new Array(n);
  let prevOpen = null, prevClose = null;
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = prevOpen == null ? (c.open + c.close) / 2 : (prevOpen + prevClose) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);
    ha[i] = { haOpen, haHigh, haLow, haClose };
    prevOpen = haOpen;
    prevClose = haClose;
  }
  return ha;
}

// SuperTrend — canonical ATR-band trend follower.
// dir = +1 bullish (line below price), -1 bearish (line above price).
function calcSuperTrend(candles, period, mult) {
  const n = candles.length;
  const atr = calcATRSeries(candles, period);
  const finalUpper = new Array(n).fill(null);
  const finalLower = new Array(n).fill(null);
  const dir = new Array(n).fill(0);
  const line = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (atr[i] == null) { dir[i] = 1; continue; }
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + mult * atr[i];
    const basicLower = hl2 - mult * atr[i];

    const prevFU = finalUpper[i - 1];
    const prevFL = finalLower[i - 1];
    const prevClose = candles[i - 1].close;

    finalUpper[i] = (prevFU == null || basicUpper < prevFU || prevClose > prevFU) ? basicUpper : prevFU;
    finalLower[i] = (prevFL == null || basicLower > prevFL || prevClose < prevFL) ? basicLower : prevFL;

    const prevDir = dir[i - 1] || 1;
    let d;
    if (prevDir === 1) {
      // was bullish — flip bearish only if close breaks below the lower band
      d = candles[i].close < finalLower[i] ? -1 : 1;
    } else {
      // was bearish — flip bullish only if close breaks above the upper band
      d = candles[i].close > finalUpper[i] ? 1 : -1;
    }
    dir[i] = d;
    line[i] = d === 1 ? finalLower[i] : finalUpper[i];
  }
  return { dir, line, atr };
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

function runBacktest(candles, cfg, verbose = false) {
  const n = candles.length;
  const ha = calcHeikinAshi(candles);
  const { dir, line, atr } = calcSuperTrend(candles, cfg.atrPeriod, cfg.atrMult);
  const ema = cfg.useEMAFilter
    ? calcEMASeries(candles.map((c) => c.close), cfg.emaLen)
    : new Array(n).fill(null);

  let portfolio = 1000; // starting $1000
  let position = null; // { side, entry, qty, stop }
  const trades = [];
  const equity = [portfolio];

  for (let i = 1; i < n; i++) {
    const price = candles[i].close;
    const date = candles[i].date;
    const a = atr[i];

    // ── Indicator state on this closed bar ───────────────────────────────────
    const stBull = dir[i] === 1;
    const stFlipBull = dir[i] === 1 && dir[i - 1] === -1;
    const stFlipBear = dir[i] === -1 && dir[i - 1] === 1;

    const { haOpen, haHigh, haLow, haClose } = ha[i];
    const haGreen = haClose > haOpen;
    const haRed = haClose < haOpen;
    const body = Math.abs(haClose - haOpen) || 1e-9;
    const lowerWick = Math.min(haOpen, haClose) - haLow; // opposing wick for a long
    const upperWick = haHigh - Math.max(haOpen, haClose); // opposing wick for a short
    const strongGreen = lowerWick <= cfg.wickThresh * body;
    const strongRed = upperWick <= cfg.wickThresh * body;

    // ── Decision tree — entry gates ──────────────────────────────────────────
    const emaUp = !cfg.useEMAFilter || (ema[i] != null && price > ema[i]);
    const emaDown = !cfg.useEMAFilter || (ema[i] != null && price < ema[i]);
    const wickOkLong = !cfg.useStrongWick || strongGreen;
    const wickOkShort = !cfg.useStrongWick || strongRed;

    const longSignal = stFlipBull && haGreen && emaUp && wickOkLong;
    const shortSignal = stFlipBear && haRed && emaDown && wickOkShort;

    // ── Stop-loss check on the open position (intrabar) ───────────────────────
    if (position) {
      const hit = position.side === "long" ? candles[i].low <= position.stop : candles[i].high >= position.stop;
      if (hit) {
        const exit = position.stop;
        const pnl = position.side === "long"
          ? (exit - position.entry) * position.qty
          : (position.entry - exit) * position.qty;
        portfolio += pnl;
        trades.push({ date, type: "stop", side: position.side, entry: position.entry, exit, pnl, portfolio });
        if (verbose) console.log(`  STOP HIT  ${date}  ${position.side.toUpperCase()} exit $${exit.toFixed(0)}  P&L $${pnl.toFixed(0)}  Portfolio $${portfolio.toFixed(0)}`);
        position = null;
      }
    }

    // ── Exit on SuperTrend flip against the position (at close) ───────────────
    if (position && ((position.side === "long" && stFlipBear) || (position.side === "short" && stFlipBull))) {
      const pnl = position.side === "long"
        ? (price - position.entry) * position.qty
        : (position.entry - price) * position.qty;
      portfolio += pnl;
      trades.push({ date, type: "flip", side: position.side, entry: position.entry, exit: price, pnl, portfolio });
      if (verbose) console.log(`  CLOSE     ${date}  ${position.side.toUpperCase()} exit $${price.toFixed(0)}  P&L $${pnl.toFixed(0)}  Portfolio $${portfolio.toFixed(0)}`);
      position = null;
    }

    // ── Open a new position on a fresh signal ─────────────────────────────────
    if (!position && (longSignal || shortSignal)) {
      const side = longSignal ? "long" : "short";
      const tradeSize = portfolio * cfg.tradeSizePct;
      const qty = tradeSize / price;
      const stopDist = a ? a * cfg.atrStopMult : price * 0.02;
      const stop = side === "long" ? price - stopDist : price + stopDist;
      position = { side, entry: price, qty, stop, sizeUSD: tradeSize };
      if (verbose) console.log(`  OPEN      ${date}  ${side.toUpperCase()} $${price.toFixed(0)}  stop $${stop.toFixed(0)}  size $${tradeSize.toFixed(0)}`);
    }

    equity.push(portfolio + (position
      ? (position.side === "long" ? (price - position.entry) * position.qty : (position.entry - price) * position.qty)
      : 0));
  }

  // Close any open position at the end
  if (position) {
    const price = candles[n - 1].close;
    const pnl = position.side === "long"
      ? (price - position.entry) * position.qty
      : (position.entry - price) * position.qty;
    portfolio += pnl;
    trades.push({ date: candles[n - 1].date, type: "end", side: position.side, entry: position.entry, exit: price, pnl, portfolio });
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  const exits = trades.filter((t) => t.pnl !== undefined);
  const wins = exits.filter((t) => t.pnl > 0);
  const losses = exits.filter((t) => t.pnl <= 0);
  const totalPnl = exits.reduce((s, t) => s + t.pnl, 0);
  const winRate = exits.length ? (wins.length / exits.length * 100).toFixed(1) : 0;
  const avgWin = wins.length ? (wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(0) : 0;
  const avgLoss = losses.length ? (losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(0) : 0;
  const profitFactor = losses.length && losses.reduce((s, t) => s + Math.abs(t.pnl), 0) > 0
    ? (wins.reduce((s, t) => s + t.pnl, 0) / Math.abs(losses.reduce((s, t) => s + t.pnl, 0))).toFixed(2)
    : "∞";

  // Max drawdown
  let peak = equity[0], maxDD = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe (annualised daily returns, risk-free = 0)
  const dailyReturns = equity.slice(1).map((v, i) => (v - equity[i]) / equity[i]);
  const meanR = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const stdR = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - meanR) ** 2, 0) / dailyReturns.length);
  const sharpe = stdR > 0 ? ((meanR / stdR) * Math.sqrt(365)).toFixed(2) : "N/A";

  return { portfolio, totalPnl, trades: exits.length, winRate, avgWin, avgLoss, profitFactor, maxDD: maxDD.toFixed(1), sharpe };
}

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_CFG = {
  atrPeriod: 10,      // SuperTrend ATR length
  atrMult: 3.0,       // SuperTrend ATR multiplier
  atrStopMult: 2.0,   // hard stop distance in ATRs
  emaLen: 200,        // trend filter EMA
  wickThresh: 0.30,   // "strong" candle: opposing wick <= 30% of body
  tradeSizePct: 0.80, // fraction of portfolio deployed per trade
  useEMAFilter: false,
  useStrongWick: false,
};

// ─── Single run — variant comparison ───────────────────────────────────────────

if (!OPTIMIZE) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Heikin Ashi + SuperTrend Backtest — Daily BTC/USD");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Candles: ${candles.length} bars  |  ${candles[0].date} → ${candles[candles.length - 1].date}\n`);

  const raw = runBacktest(candles, { ...BASE_CFG });
  const ema = runBacktest(candles, { ...BASE_CFG, useEMAFilter: true });
  const wick = runBacktest(candles, { ...BASE_CFG, useStrongWick: true });
  const both = runBacktest(candles, { ...BASE_CFG, useEMAFilter: true, useStrongWick: true });

  const fmt = (r, label) => {
    const ret = ((r.portfolio - 1000) / 10).toFixed(1);
    return `  ${label.padEnd(26)} $${r.portfolio.toFixed(0).padStart(8)}  ${(ret + "%").padStart(8)}  ${String(r.trades).padStart(6)}  ${(r.winRate + "%").padStart(7)}  ${String(r.profitFactor).padStart(5)}  ${(r.maxDD + "%").padStart(7)}  ${r.sharpe}`;
  };

  console.log(`  ${"Variant".padEnd(26)} ${"Portfolio".padStart(9)}  ${"Return".padStart(8)}  ${"Trades".padStart(6)}  ${"WinRate".padStart(7)}  ${"PF".padStart(5)}  ${"MaxDD".padStart(7)}  Sharpe`);
  console.log("  " + "─".repeat(96));
  console.log(fmt(raw, "HA+ST (raw tree)"));
  console.log(fmt(ema, "+ EMA200 filter"));
  console.log(fmt(wick, "+ strong-wick gate"));
  console.log(fmt(both, "+ EMA200 + strong-wick"));

  const ranked = [
    { label: "raw tree", r: raw },
    { label: "EMA200 filter", r: ema },
    { label: "strong-wick", r: wick },
    { label: "EMA200 + strong-wick", r: both },
  ].sort((a, b) => parseFloat(b.r.sharpe) - parseFloat(a.r.sharpe));
  console.log(`\n  Best Sharpe: ${ranked[0].label} (${ranked[0].r.sharpe})`);

  console.log("\n── HA+ST with EMA200 filter — full trade log ────────────\n");
  runBacktest(candles, { ...BASE_CFG, useEMAFilter: true }, true);
  console.log("\n═══════════════════════════════════════════════════════════\n");
}

// ─── Grid optimisation ──────────────────────────────────────────────────────────

if (OPTIMIZE) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  HA+ST Parameter Optimisation — Grid Search");
  console.log("═══════════════════════════════════════════════════════════\n");

  const results = [];
  const atrPeriods = [7, 10, 14];
  const atrMults = [2.0, 2.5, 3.0, 3.5];
  const emaLens = [100, 200];
  const filters = [false, true];

  const total = atrPeriods.length * atrMults.length * emaLens.length * filters.length;
  let done = 0;

  for (const atrPeriod of atrPeriods) {
    for (const atrMult of atrMults) {
      for (const emaLen of emaLens) {
        for (const useEMAFilter of filters) {
          const cfg = { ...BASE_CFG, atrPeriod, atrMult, emaLen, useEMAFilter };
          const r = runBacktest(candles, cfg);
          results.push({ atrPeriod, atrMult, emaLen, useEMAFilter, ...r });
          done++;
          if (done % 5 === 0) process.stdout.write(`\r  Progress: ${done}/${total}`);
        }
      }
    }
  }

  results.sort((a, b) => parseFloat(b.sharpe) - parseFloat(a.sharpe));

  console.log("\n\n── Top 10 parameter sets (ranked by Sharpe) ─────────────\n");
  console.log("  atrP  atrMult  emaLen  EMAfilt  Return%  WinRate  PF     MaxDD%  Sharpe  Trades");
  console.log("  " + "─".repeat(82));
  for (const r of results.slice(0, 10)) {
    const ret = ((r.portfolio - 1000) / 1000 * 100).toFixed(0);
    console.log(
      `  ${String(r.atrPeriod).padEnd(5)} ${r.atrMult.toFixed(1).padEnd(8)} ${String(r.emaLen).padEnd(7)} ${String(r.useEMAFilter).padEnd(8)} ${ret.padStart(7)}%  ${String(r.winRate).padEnd(7)}  ${String(r.profitFactor).padEnd(6)} ${String(r.maxDD).padEnd(7)} ${String(r.sharpe).padEnd(7)} ${r.trades}`
    );
  }

  const best = results[0];
  console.log(`\n── Best configuration ────────────────────────────────────\n`);
  console.log(`  atrPeriod:    ${best.atrPeriod}`);
  console.log(`  atrMult:      ${best.atrMult}`);
  console.log(`  emaLen:       ${best.emaLen}`);
  console.log(`  useEMAFilter: ${best.useEMAFilter}`);
  console.log(`  → Return: ${((best.portfolio - 1000) / 1000 * 100).toFixed(1)}%  Sharpe: ${best.sharpe}  MaxDD: ${best.maxDD}%  Trades: ${best.trades}`);
  console.log("\n═══════════════════════════════════════════════════════════\n");
}
