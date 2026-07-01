/**
 * NKB Backtest — runs the full strategy against historical daily OHLC data.
 * Usage: node backtest.js [csv-path] [--optimize]
 *
 * Without --optimize: runs single backtest with current settings and prints full trade log.
 * With --optimize:    grid-searches bandMult, bandwidth, atrStopMult and ranks by Sharpe.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// ─── Load CSV ─────────────────────────────────────────────────────────────────

const csvPath = process.argv[2] || "C:/Users/odger/Downloads/HistoricalData_1782898498599.csv";
const OPTIMIZE = process.argv.includes("--optimize");

const lines = readFileSync(resolve(csvPath), "utf8").trim().split("\n").slice(1); // skip header
const candles = lines
  .map((l) => {
    const [date, close, , open, high, low] = l.split(",");
    return {
      date: date.trim(),
      open:  parseFloat(open),
      high:  parseFloat(high),
      low:   parseFloat(low),
      close: parseFloat(close),
      volume: 1, // no volume in dataset — treat as uniform
    };
  })
  .filter((c) => !isNaN(c.close))
  .reverse(); // CSV is newest-first; flip to oldest-first

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

function calcStddevSeries(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1).map((v) => v ?? 0);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    out[i] = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  }
  return out;
}

function calcNKBSeries(candles, cfg) {
  const closes = candles.map((c) => c.close);
  const n = closes.length;

  const atrArr    = calcATRSeries(candles, cfg.atrLen);
  const atrNorm   = atrArr.map((a, i) => (a != null ? a / closes[i] : null));
  const atrFactor = calcEMASeries(atrNorm, cfg.atrLen);
  const h         = atrFactor.map((f) => cfg.bandwidth * (cfg.adaptive ? 1 + (f ?? 0) * 200 : 1));

  const nwRaw = new Array(n);
  for (let i = 0; i < n; i++) {
    const hi = h[i];
    let sumW = 0, sumWC = 0;
    const lookback = Math.min(cfg.length, i + 1);
    for (let j = 0; j < lookback; j++) {
      const kw = Math.exp(-(j * j) / (2 * hi * hi));
      sumWC += kw * closes[i - j];
      sumW  += kw;
    }
    nwRaw[i] = sumW > 0 ? sumWC / sumW : closes[i];
  }

  const kernelArr  = calcEMASeries(nwRaw, cfg.smooth);
  const residuals  = closes.map((c, i) => (kernelArr[i] != null ? c - kernelArr[i] : null));
  const sigmaRaw   = calcStddevSeries(residuals, cfg.bandLen);
  const sigmaArr   = calcEMASeries(sigmaRaw, cfg.bandSmooth);

  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (kernelArr[i] == null || sigmaArr[i] == null) continue;
    upper[i] = kernelArr[i] + cfg.bandMult * sigmaArr[i];
    lower[i] = kernelArr[i] - cfg.bandMult * sigmaArr[i];
  }

  // Sticky state — matches Pine Script lastState logic
  const state = new Array(n).fill(0);
  let lastState = 0;
  for (let i = 0; i < n; i++) {
    if (upper[i] == null) { state[i] = lastState; continue; }
    if (closes[i] > upper[i])      lastState = 1;
    else if (closes[i] < lower[i]) lastState = -1;
    state[i] = lastState;
  }

  return { upper, lower, state, atrArr };
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

function runBacktest(candles, cfg, verbose = false) {
  const { state, atrArr } = calcNKBSeries(candles, cfg);
  const n = candles.length;

  let portfolio   = 1000; // starting $1000
  let position    = null; // { side, entry, qty, stop }
  let prevState   = 0;
  let pendingSignal = null;
  let pendingBars   = 0;

  const trades    = [];
  const equity    = [portfolio];

  for (let i = 1; i < n; i++) {
    const price    = candles[i].close;
    const curState = state[i];
    const atr      = atrArr[i];
    const date     = candles[i].date;

    // Build pending signal with 2-bar confirmation
    const flippedBull = curState === 1  && prevState !== 1;
    const flippedBear = curState === -1 && prevState !== -1;

    if (flippedBull)                       { pendingSignal = "BUY";  pendingBars = 1; }
    else if (flippedBear)                  { pendingSignal = "SELL"; pendingBars = 1; }
    else if (curState === prevState)       { pendingBars++; }
    else                                   { pendingSignal = null; pendingBars = 0; }

    prevState = curState;

    const buySignal  = pendingSignal === "BUY"  && pendingBars >= cfg.confirmBars;
    const sellSignal = pendingSignal === "SELL" && pendingBars >= cfg.confirmBars;

    // Check stop loss on open position
    if (position) {
      const hit = position.side === "long" ? price <= position.stop : price >= position.stop;
      if (hit) {
        const pnl    = position.side === "long"
          ? (position.stop - position.entry) * position.qty
          : (position.entry - position.stop) * position.qty;
        portfolio += pnl;
        trades.push({ date, type: "stop", side: position.side, entry: position.entry, exit: position.stop, pnl, portfolio });
        if (verbose) console.log(`  STOP HIT  ${date}  ${position.side.toUpperCase()} exit $${position.stop.toFixed(0)}  P&L $${pnl.toFixed(0)}  Portfolio $${portfolio.toFixed(0)}`);
        position = null;
        pendingSignal = null; pendingBars = 0;
      }
    }

    // Close + flip on NKB signal
    if (position && ((position.side === "long" && sellSignal) || (position.side === "short" && buySignal))) {
      const pnl = position.side === "long"
        ? (price - position.entry) * position.qty
        : (position.entry - price) * position.qty;
      portfolio += pnl;
      trades.push({ date, type: "signal", side: position.side, entry: position.entry, exit: price, pnl, portfolio });
      if (verbose) console.log(`  CLOSE     ${date}  ${position.side.toUpperCase()} exit $${price.toFixed(0)}  P&L $${pnl.toFixed(0)}  Portfolio $${portfolio.toFixed(0)}`);
      position = null;
    }

    // Open new position
    if (!position && (buySignal || sellSignal)) {
      const side      = buySignal ? "long" : "short";
      const tradeSize = portfolio * cfg.tradeSizePct;
      const qty       = tradeSize / price;
      const stopDist  = atr ? atr * cfg.atrStopMult : price * 0.02;
      const stop      = side === "long" ? price - stopDist : price + stopDist;
      position = { side, entry: price, qty, stop, sizeUSD: tradeSize };
      if (verbose) console.log(`  OPEN      ${date}  ${side.toUpperCase()} $${price.toFixed(0)}  stop $${stop.toFixed(0)}  size $${tradeSize.toFixed(0)}`);
    }

    equity.push(portfolio + (position
      ? (position.side === "long" ? (price - position.entry) * position.qty : (position.entry - price) * position.qty)
      : 0));
  }

  // Close open position at end
  if (position) {
    const price = candles[n - 1].close;
    const pnl   = position.side === "long"
      ? (price - position.entry) * position.qty
      : (position.entry - price) * position.qty;
    portfolio += pnl;
    trades.push({ date: candles[n - 1].date, type: "end", side: position.side, entry: position.entry, exit: price, pnl, portfolio });
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  const exits   = trades.filter((t) => t.pnl !== undefined);
  const wins    = exits.filter((t) => t.pnl > 0);
  const losses  = exits.filter((t) => t.pnl <= 0);
  const totalPnl = exits.reduce((s, t) => s + t.pnl, 0);
  const winRate  = exits.length ? (wins.length / exits.length * 100).toFixed(1) : 0;
  const avgWin   = wins.length ? (wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(0) : 0;
  const avgLoss  = losses.length ? (losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(0) : 0;
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
  const stdR  = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - meanR) ** 2, 0) / dailyReturns.length);
  const sharpe = stdR > 0 ? ((meanR / stdR) * Math.sqrt(365)).toFixed(2) : "N/A";

  return { portfolio, totalPnl, trades: exits.length, winRate, avgWin, avgLoss, profitFactor, maxDD: maxDD.toFixed(1), sharpe };
}

// ─── Single run ───────────────────────────────────────────────────────────────

const BASE_CFG = {
  length: 30, bandwidth: 6.0, adaptive: true, atrLen: 14,
  smooth: 3, bandMult: 3.0, bandLen: 24, bandSmooth: 5,
  atrStopMult: 1.0, confirmBars: 2, tradeSizePct: 0.80,
};

if (!OPTIMIZE) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  NKB Backtest — Daily BTC/USD  2019–2026");
  console.log("═══════════════════════════════════════════════════════════\n");
  console.log(`  Candles:      ${candles.length} daily bars`);
  console.log(`  Period:       ${candles[0].date} → ${candles[candles.length - 1].date}`);
  console.log(`  Start equity: $1,000\n`);

  const r = runBacktest(candles, BASE_CFG, true);

  console.log("\n── Results ───────────────────────────────────────────────\n");
  console.log(`  Final portfolio:  $${r.portfolio.toFixed(2)}`);
  console.log(`  Total P&L:        $${r.totalPnl.toFixed(2)} (${((r.portfolio - 1000) / 1000 * 100).toFixed(1)}%)`);
  console.log(`  Total trades:     ${r.trades}`);
  console.log(`  Win rate:         ${r.winRate}%`);
  console.log(`  Avg win:          $${r.avgWin}`);
  console.log(`  Avg loss:         $${r.avgLoss}`);
  console.log(`  Profit factor:    ${r.profitFactor}`);
  console.log(`  Max drawdown:     ${r.maxDD}%`);
  console.log(`  Sharpe ratio:     ${r.sharpe}`);
  console.log("\n═══════════════════════════════════════════════════════════\n");
}

// ─── Grid optimisation ────────────────────────────────────────────────────────

if (OPTIMIZE) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  NKB Parameter Optimisation — Grid Search");
  console.log("═══════════════════════════════════════════════════════════\n");

  const results = [];

  const bandMults    = [1.5, 2.0, 2.5, 3.0];
  const bandwidths   = [6, 8, 10, 14];
  const atrStopMults = [1.0, 1.5, 2.0, 3.0];
  const confirmBarsArr = [1, 2, 3];

  const total = bandMults.length * bandwidths.length * atrStopMults.length * confirmBarsArr.length;
  let done = 0;

  for (const bandMult of bandMults) {
    for (const bandwidth of bandwidths) {
      for (const atrStopMult of atrStopMults) {
        for (const confirmBars of confirmBarsArr) {
          const cfg = { ...BASE_CFG, bandMult, bandwidth, atrStopMult, confirmBars };
          const r   = runBacktest(candles, cfg);
          results.push({ bandMult, bandwidth, atrStopMult, confirmBars, ...r });
          done++;
          if (done % 10 === 0) process.stdout.write(`\r  Progress: ${done}/${total}`);
        }
      }
    }
  }

  // Sort by Sharpe
  results.sort((a, b) => parseFloat(b.sharpe) - parseFloat(a.sharpe));

  console.log("\n\n── Top 10 parameter sets (ranked by Sharpe) ─────────────\n");
  console.log("  bandMult  BW  atrStop  confirmBars  Return%  WinRate  PF    MaxDD%  Sharpe  Trades");
  console.log("  " + "─".repeat(85));

  for (const r of results.slice(0, 10)) {
    const ret = ((r.portfolio - 1000) / 1000 * 100).toFixed(0);
    console.log(
      `  ${r.bandMult.toFixed(1).padEnd(9)} ${String(r.bandwidth).padEnd(4)} ${r.atrStopMult.toFixed(1).padEnd(9)} ${String(r.confirmBars).padEnd(13)} ${ret.padStart(7)}%  ${String(r.winRate).padEnd(7)}  ${String(r.profitFactor).padEnd(6)} ${String(r.maxDD).padEnd(7)} ${String(r.sharpe).padEnd(7)} ${r.trades}`
    );
  }

  const best = results[0];
  console.log(`\n── Best configuration ────────────────────────────────────\n`);
  console.log(`  bandMult:    ${best.bandMult}`);
  console.log(`  bandwidth:   ${best.bandwidth}`);
  console.log(`  atrStopMult: ${best.atrStopMult}`);
  console.log(`  confirmBars: ${best.confirmBars}`);
  console.log(`  → Return: ${((best.portfolio - 1000) / 1000 * 100).toFixed(1)}%  Sharpe: ${best.sharpe}  MaxDD: ${best.maxDD}%  Trades: ${best.trades}`);
  console.log("\n═══════════════════════════════════════════════════════════\n");
}
