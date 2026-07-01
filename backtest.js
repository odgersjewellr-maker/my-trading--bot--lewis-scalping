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

const OPTIMIZE = process.argv.includes("--optimize");
const csvPath = process.argv.filter(a => !a.startsWith("--"))[2] || "btc-daily-binance.csv";

const lines = readFileSync(resolve(csvPath), "utf8").trim().split("\n").slice(1); // skip header
const candles = lines
  .map((l) => {
    const [date, open, high, low, close, volume] = l.split(",");
    return {
      date: date.trim(),
      open:  parseFloat(open),
      high:  parseFloat(high),
      low:   parseFloat(low),
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

// ADX series — returns { adx, plusDI, minusDI } arrays
function calcADXSeries(candles, period = 14) {
  const n = candles.length;
  const plusDM  = new Array(n).fill(null);
  const minusDM = new Array(n).fill(null);
  const tr      = new Array(n).fill(null);

  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const upMove   = c.high - p.high;
    const downMove = p.low  - c.low;
    plusDM[i]  = (upMove > downMove && upMove > 0)   ? upMove   : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
  }

  // Wilder smoothing (same as ATR)
  const smTR = new Array(n).fill(null);
  const smPlus = new Array(n).fill(null);
  const smMinus = new Array(n).fill(null);
  let initTR = 0, initPlus = 0, initMinus = 0;
  for (let i = 1; i <= period; i++) { initTR += tr[i]; initPlus += plusDM[i]; initMinus += minusDM[i]; }
  smTR[period] = initTR; smPlus[period] = initPlus; smMinus[period] = initMinus;
  for (let i = period + 1; i < n; i++) {
    smTR[i]    = smTR[i-1]    - smTR[i-1]    / period + tr[i];
    smPlus[i]  = smPlus[i-1]  - smPlus[i-1]  / period + plusDM[i];
    smMinus[i] = smMinus[i-1] - smMinus[i-1] / period + minusDM[i];
  }

  const plusDI  = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const dx      = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (!smTR[i]) continue;
    plusDI[i]  = 100 * smPlus[i]  / smTR[i];
    minusDI[i] = 100 * smMinus[i] / smTR[i];
    const diSum = plusDI[i] + minusDI[i];
    dx[i] = diSum > 0 ? 100 * Math.abs(plusDI[i] - minusDI[i]) / diSum : 0;
  }

  // ADX = Wilder-smoothed DX
  const adx = new Array(n).fill(null);
  const start = period * 2;
  if (start >= n) return { adx, plusDI, minusDI };
  let sumDX = 0;
  for (let i = period; i < start; i++) sumDX += dx[i] ?? 0;
  adx[start - 1] = sumDX / period;
  for (let i = start; i < n; i++) adx[i] = (adx[i-1] * (period - 1) + (dx[i] ?? 0)) / period;

  return { adx, plusDI, minusDI };
}

// MACD series — returns { macd, signal, hist } arrays
function calcMACDSeries(candles, fast = 12, slow = 26, sigPeriod = 9) {
  const closes = candles.map(c => c.close);
  const emaFast = calcEMASeries(closes, fast);
  const emaSlow = calcEMASeries(closes, slow);
  const macd    = emaFast.map((f, i) => f != null && emaSlow[i] != null ? f - emaSlow[i] : null);
  const signal  = calcEMASeries(macd, sigPeriod);
  const hist    = macd.map((m, i) => m != null && signal[i] != null ? m - signal[i] : null);
  return { macd, signal, hist };
}

// Rolling Volume Profile POC — returns price level of highest-volume bucket over lookback bars
function calcPOCSeries(candles, lookback = 50, buckets = 40) {
  const n = candles.length;
  const poc = new Array(n).fill(null);
  for (let i = lookback; i < n; i++) {
    const window = candles.slice(i - lookback, i);
    const lo = Math.min(...window.map(c => c.low));
    const hi = Math.max(...window.map(c => c.high));
    const bucketSize = (hi - lo) / buckets;
    if (bucketSize === 0) continue;
    const vol = new Array(buckets).fill(0);
    for (const c of window) {
      const mid = (c.high + c.low) / 2;
      const b = Math.min(Math.floor((mid - lo) / bucketSize), buckets - 1);
      vol[b] += c.volume;
    }
    const maxBucket = vol.indexOf(Math.max(...vol));
    poc[i] = lo + (maxBucket + 0.5) * bucketSize;
  }
  return poc;
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
  const pocArr = cfg.usePOC ? calcPOCSeries(candles, cfg.pocLookback || 50) : new Array(candles.length).fill(null);
  const POC_ZONE = cfg.pocZonePct || 0.005;
  const macdData = cfg.useMACDHold ? calcMACDSeries(candles, cfg.macdFast || 12, cfg.macdSlow || 26, cfg.macdSignal || 9) : null;
  const adxData  = cfg.useADXHold  ? calcADXSeries(candles, cfg.adxPeriod || 14) : null;
  const ADX_HOLD = cfg.adxHoldThreshold || 25; // hold trade while ADX above this
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

    const rawBuy  = pendingSignal === "BUY"  && pendingBars >= cfg.confirmBars;
    const rawSell = pendingSignal === "SELL" && pendingBars >= cfg.confirmBars;

    // POC filter: skip if price is within POC dead zone AND moving toward it
    const poc = pocArr[i];
    let pocBlocked = false;
    if (poc && cfg.usePOC) {
      const nearPOC = Math.abs(price - poc) / poc < POC_ZONE;
      // Trading INTO poc = buying below poc heading up to it, or selling above heading down
      const buyingIntoPOC  = rawBuy  && price < poc && nearPOC;
      const sellingIntoPOC = rawSell && price > poc && nearPOC;
      pocBlocked = buyingIntoPOC || sellingIntoPOC;
    }

    const buySignal  = rawBuy  && !pocBlocked;
    const sellSignal = rawSell && !pocBlocked;

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

    // ADX hold — stay in trade while trend is still strong
    let adxHolding = false;
    if (cfg.useADXHold && adxData && position) {
      const adxVal = adxData.adx[i];
      if (adxVal != null && adxVal >= ADX_HOLD) {
        if (position.side === "long"  && sellSignal) adxHolding = true;
        if (position.side === "short" && buySignal)  adxHolding = true;
      }
    }

    // MACD hold — stay in if momentum still aligned
    let macdHolding = false;
    if (cfg.useMACDHold && macdData && position && !adxHolding) {
      const m = macdData.macd[i], s = macdData.signal[i];
      if (m != null && s != null) {
        if (position.side === "long"  && sellSignal && m > s)  macdHolding = true;
        if (position.side === "short" && buySignal  && m <= s) macdHolding = true;
      }
    }

    const holding = adxHolding || macdHolding;

    // Close + flip on NKB signal (unless hold filter active)
    if (!holding && position && ((position.side === "long" && sellSignal) || (position.side === "short" && buySignal))) {
      const pnl = position.side === "long"
        ? (price - position.entry) * position.qty
        : (position.entry - price) * position.qty;
      portfolio += pnl;
      trades.push({ date, type: "signal", side: position.side, entry: position.entry, exit: price, pnl, portfolio });
      if (verbose) console.log(`  CLOSE     ${date}  ${position.side.toUpperCase()} exit $${price.toFixed(0)}  P&L $${pnl.toFixed(0)}  Portfolio $${portfolio.toFixed(0)}`);
      position = null;
    }
    if (holding && verbose) {
      const adxVal = adxData?.adx[i];
      const reason = adxHolding ? `ADX ${adxVal?.toFixed(1)} > ${ADX_HOLD}` : `MACD momentum`;
      console.log(`  HOLD      ${date}  ${reason} — NKB flip ignored`);
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
  length: 30, bandwidth: 10.0, adaptive: true, atrLen: 14,
  smooth: 3, bandMult: 1.5, bandLen: 24, bandSmooth: 5,
  atrStopMult: 1.5, confirmBars: 1, tradeSizePct: 0.80,
  usePOC: false, pocLookback: 50, pocZonePct: 0.04, // 4% zone — p20 of daily BTC POC distance
};

if (!OPTIMIZE) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  NKB Backtest — Daily BTC/USD  (with real volume)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Candles: ${candles.length} bars  |  ${candles[0].date} → ${candles[candles.length - 1].date}\n`);

  const r1  = runBacktest(candles, { ...BASE_CFG, useADXHold: false });
  const r20 = runBacktest(candles, { ...BASE_CFG, useADXHold: true, adxHoldThreshold: 20 });
  const r25 = runBacktest(candles, { ...BASE_CFG, useADXHold: true, adxHoldThreshold: 25 });
  const r30 = runBacktest(candles, { ...BASE_CFG, useADXHold: true, adxHoldThreshold: 30 });

  const fmt = (r, label) => {
    const ret = ((r.portfolio - 1000) / 10).toFixed(1);
    return `  ${label.padEnd(22)} $${r.portfolio.toFixed(0).padStart(8)}  ${(ret+"%").padStart(8)}  ${String(r.trades).padStart(6)}  ${(r.winRate+"%").padStart(7)}  ${String(r.profitFactor).padStart(5)}  ${(r.maxDD+"%").padStart(7)}  ${r.sharpe}`;
  };

  console.log(`  ${"Label".padEnd(22)} ${"Portfolio".padStart(9)}  ${"Return".padStart(8)}  ${"Trades".padStart(6)}  ${"WinRate".padStart(7)}  ${"PF".padStart(5)}  ${"MaxDD".padStart(7)}  Sharpe`);
  console.log("  " + "─".repeat(90));
  console.log(fmt(r1,  "NKB only"));
  console.log(fmt(r20, "NKB + ADX hold >20"));
  console.log(fmt(r25, "NKB + ADX hold >25"));
  console.log(fmt(r30, "NKB + ADX hold >30"));

  // Find best
  const best = [
    { label: "NKB only",           r: r1  },
    { label: "ADX hold >20",       r: r20 },
    { label: "ADX hold >25",       r: r25 },
    { label: "ADX hold >30",       r: r30 },
  ].sort((a, b) => parseFloat(b.r.sharpe) - parseFloat(a.r.sharpe))[0];
  console.log(`\n  Best Sharpe: ${best.label} (${best.r.sharpe})`);

  console.log("\n── NKB + ADX hold >25 — full trade log ──────────────────\n");
  runBacktest(candles, { ...BASE_CFG, useADXHold: true, adxHoldThreshold: 25 }, true);
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
