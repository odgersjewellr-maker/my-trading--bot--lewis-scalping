/**
 * NKB Engine — shared signal + backtest core for research tooling.
 *
 * Mirrors the strategy logic in backtest.js, and adds three things the research
 * scripts need but the reference backtest does not:
 *   1. trading costs   — cfg.feeRate + cfg.slippage charged on every fill;
 *   2. entry filters   — cfg.adxEntryMin (regime), cfg.trendFilterEMA (bias);
 *   3. risk sizing      — cfg.riskPct (size to a fixed stop-loss risk instead of
 *                         a fixed fraction of equity).
 * All three default to off, so with a bare cfg this reproduces backtest.js.
 *
 * Consumed by walkforward.js (honest OOS validation) and strategy-lab.js
 * (A/B testing candidate improvements). Single source of truth so the two
 * cannot silently disagree.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// ─── Data ────────────────────────────────────────────────────────────────────────

export function loadCandles(csvPath) {
  return readFileSync(resolve(csvPath), "utf8").trim().split("\n").slice(1)
    .map((l) => {
      const [date, open, high, low, close, volume] = l.split(",");
      return { date: date.trim(), open: +open, high: +high, low: +low, close: +close, volume: +volume };
    })
    .filter((c) => !isNaN(c.close));
}

// ─── Indicators ────────────────────────────────────────────────────────────────

export function calcATRSeries(candles, period) {
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

export function calcEMASeries(values, period) {
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

export function calcADXSeries(candles, period = 14) {
  const n = candles.length;
  const plusDM = new Array(n).fill(null), minusDM = new Array(n).fill(null), tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const upMove = c.high - p.high, downMove = p.low - c.low;
    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
  }
  const smTR = new Array(n).fill(null), smPlus = new Array(n).fill(null), smMinus = new Array(n).fill(null);
  let iTR = 0, iP = 0, iM = 0;
  for (let i = 1; i <= period; i++) { iTR += tr[i]; iP += plusDM[i]; iM += minusDM[i]; }
  smTR[period] = iTR; smPlus[period] = iP; smMinus[period] = iM;
  for (let i = period + 1; i < n; i++) {
    smTR[i] = smTR[i - 1] - smTR[i - 1] / period + tr[i];
    smPlus[i] = smPlus[i - 1] - smPlus[i - 1] / period + plusDM[i];
    smMinus[i] = smMinus[i - 1] - smMinus[i - 1] / period + minusDM[i];
  }
  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (!smTR[i]) continue;
    const pDI = 100 * smPlus[i] / smTR[i], mDI = 100 * smMinus[i] / smTR[i];
    const s = pDI + mDI;
    dx[i] = s > 0 ? 100 * Math.abs(pDI - mDI) / s : 0;
  }
  const adx = new Array(n).fill(null);
  const start = period * 2;
  if (start >= n) return { adx };
  let sumDX = 0;
  for (let i = period; i < start; i++) sumDX += dx[i] ?? 0;
  adx[start - 1] = sumDX / period;
  for (let i = start; i < n; i++) adx[i] = (adx[i - 1] * (period - 1) + (dx[i] ?? 0)) / period;
  return { adx };
}

function calcStddevSeries(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const w = values.slice(i - period + 1, i + 1).map((v) => v ?? 0);
    const mean = w.reduce((a, b) => a + b, 0) / period;
    out[i] = Math.sqrt(w.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  }
  return out;
}

export function calcNKBSeries(candles, cfg) {
  const closes = candles.map((c) => c.close);
  const n = closes.length;
  const atrArr = calcATRSeries(candles, cfg.atrLen);
  const atrNorm = atrArr.map((a, i) => (a != null ? a / closes[i] : null));
  const atrFactor = calcEMASeries(atrNorm, cfg.atrLen);
  const h = atrFactor.map((f) => cfg.bandwidth * (cfg.adaptive ? 1 + (f ?? 0) * 200 : 1));

  const nwRaw = new Array(n);
  for (let i = 0; i < n; i++) {
    const hi = h[i];
    let sumW = 0, sumWC = 0;
    const lookback = Math.min(cfg.length, i + 1);
    for (let j = 0; j < lookback; j++) {
      const kw = Math.exp(-(j * j) / (2 * hi * hi));
      sumWC += kw * closes[i - j];
      sumW += kw;
    }
    nwRaw[i] = sumW > 0 ? sumWC / sumW : closes[i];
  }

  const kernelArr = calcEMASeries(nwRaw, cfg.smooth);
  const residuals = closes.map((c, i) => (kernelArr[i] != null ? c - kernelArr[i] : null));
  const sigmaRaw = calcStddevSeries(residuals, cfg.bandLen);
  const sigmaArr = calcEMASeries(sigmaRaw, cfg.bandSmooth);

  const upper = new Array(n).fill(null), lower = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (kernelArr[i] == null || sigmaArr[i] == null) continue;
    upper[i] = kernelArr[i] + cfg.bandMult * sigmaArr[i];
    lower[i] = kernelArr[i] - cfg.bandMult * sigmaArr[i];
  }

  const state = new Array(n).fill(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    if (upper[i] == null) { state[i] = last; continue; }
    if (closes[i] > upper[i]) last = 1;
    else if (closes[i] < lower[i]) last = -1;
    state[i] = last;
  }
  return { upper, lower, state, atrArr };
}

// ─── Backtest engine (fees + entry filters + risk sizing) ────────────────────────

export function runBacktest(candles, cfg) {
  const { state, atrArr } = calcNKBSeries(candles, cfg);
  const needAdx = cfg.useADXHold || cfg.adxEntryMin;
  const adx = needAdx ? calcADXSeries(candles, cfg.adxPeriod || 14).adx : null;
  const trendEMA = cfg.trendFilterEMA ? calcEMASeries(candles.map((c) => c.close), cfg.trendFilterEMA) : null;
  const ADX_HOLD = cfg.adxHoldThreshold || 25;
  const costRate = (cfg.feeRate ?? 0) + (cfg.slippage ?? 0);
  const n = candles.length;

  let portfolio = 1000, position = null, prevState = 0, pendingSignal = null, pendingBars = 0;
  const trades = [];
  const equity = [{ date: candles[0].date, value: portfolio }];
  const fee = (notional) => notional * costRate;

  for (let i = 1; i < n; i++) {
    const price = candles[i].close, curState = state[i], atr = atrArr[i], date = candles[i].date;

    const flippedBull = curState === 1 && prevState !== 1;
    const flippedBear = curState === -1 && prevState !== -1;
    if (flippedBull) { pendingSignal = "BUY"; pendingBars = 1; }
    else if (flippedBear) { pendingSignal = "SELL"; pendingBars = 1; }
    else if (curState === prevState) { pendingBars++; }
    else { pendingSignal = null; pendingBars = 0; }
    prevState = curState;

    const buySignal = pendingSignal === "BUY" && pendingBars >= cfg.confirmBars;
    const sellSignal = pendingSignal === "SELL" && pendingBars >= cfg.confirmBars;

    // Stop loss
    if (position) {
      const hit = position.side === "long" ? price <= position.stop : price >= position.stop;
      if (hit) {
        let pnl = (position.side === "long" ? position.stop - position.entry : position.entry - position.stop) * position.qty;
        pnl -= fee(position.stop * position.qty);
        portfolio += pnl;
        trades.push({ date, type: "stop", side: position.side, pnl, portfolio });
        position = null; pendingSignal = null; pendingBars = 0;
      }
    }

    // ADX hold — keep the trade while the trend is still strong
    let holding = false;
    if (cfg.useADXHold && adx && position && adx[i] != null && adx[i] >= ADX_HOLD) {
      if (position.side === "long" && sellSignal) holding = true;
      if (position.side === "short" && buySignal) holding = true;
    }

    // Close + flip on opposing signal
    if (!holding && position && ((position.side === "long" && sellSignal) || (position.side === "short" && buySignal))) {
      let pnl = (position.side === "long" ? price - position.entry : position.entry - price) * position.qty;
      pnl -= fee(price * position.qty);
      portfolio += pnl;
      trades.push({ date, type: "signal", side: position.side, pnl, portfolio });
      position = null;
    }

    // Open — subject to entry filters
    if (!position && (buySignal || sellSignal)) {
      const side = buySignal ? "long" : "short";
      let allowed = true;
      if (cfg.trendFilterEMA && trendEMA[i] != null) {
        if (side === "long" && price < trendEMA[i]) allowed = false;
        if (side === "short" && price > trendEMA[i]) allowed = false;
      }
      if (cfg.adxEntryMin && (adx?.[i] ?? 0) < cfg.adxEntryMin) allowed = false;

      if (allowed) {
        const stopDist = atr ? atr * cfg.atrStopMult : price * 0.02;
        const stop = side === "long" ? price - stopDist : price + stopDist;
        let tradeSize = portfolio * cfg.tradeSizePct;
        if (cfg.riskPct) {
          const sizeByRisk = (portfolio * cfg.riskPct) * price / stopDist; // loss at stop == riskPct of equity
          tradeSize = Math.min(sizeByRisk, portfolio * cfg.tradeSizePct);   // never exceed the equity-fraction cap
        }
        const qty = tradeSize / price;
        portfolio -= fee(tradeSize); // entry cost
        position = { side, entry: price, qty, stop };
      }
    }

    equity.push({
      date,
      value: portfolio + (position
        ? (position.side === "long" ? (price - position.entry) * position.qty : (position.entry - price) * position.qty)
        : 0),
    });
  }

  if (position) {
    const price = candles[n - 1].close;
    let pnl = (position.side === "long" ? price - position.entry : position.entry - price) * position.qty;
    pnl -= fee(price * position.qty);
    portfolio += pnl;
    trades.push({ date: candles[n - 1].date, type: "end", side: position.side, pnl, portfolio });
  }

  return { portfolio, trades, equity, ...stats(trades, equity) };
}

export function stats(trades, equity) {
  const exits = trades.filter((t) => t.pnl !== undefined);
  const wins = exits.filter((t) => t.pnl > 0), losses = exits.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  let peak = equity[0].value, maxDD = 0;
  for (const e of equity) { if (e.value > peak) peak = e.value; const dd = peak > 0 ? (peak - e.value) / peak * 100 : 0; if (dd > maxDD) maxDD = dd; }
  const rets = equity.slice(1).map((e, i) => (e.value - equity[i].value) / (equity[i].value || 1));
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1));
  return {
    nTrades: exits.length,
    winRate: exits.length ? wins.length / exits.length * 100 : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    maxDD,
    sharpe: std > 0 ? (mean / std) * Math.sqrt(365) : 0,
  };
}

// ─── Config + parameter grid ─────────────────────────────────────────────────────

export const BASE_CFG = {
  length: 30, bandwidth: 10.0, adaptive: true, atrLen: 14,
  smooth: 3, bandMult: 1.5, bandLen: 24, bandSmooth: 5,
  atrStopMult: 1.5, confirmBars: 1, tradeSizePct: 0.80, usePOC: false,
  feeRate: 0.0006, slippage: 0.0005,
};

// Every grid config, with an optional overlay merged on top (used to force a
// candidate filter ON while still optimising the core NKB params around it).
export function gridConfigs(overlay = {}) {
  const out = [];
  for (const bandMult of [1.5, 2.0, 2.5, 3.0])
    for (const bandwidth of [6, 10, 14])
      for (const atrStopMult of [1.0, 1.5, 2.0, 3.0])
        for (const confirmBars of [1, 2])
          for (const adx of [{ useADXHold: false }, { useADXHold: true, adxHoldThreshold: 25 }])
            out.push({ ...BASE_CFG, bandMult, bandwidth, atrStopMult, confirmBars, ...adx, ...overlay });
  return out;
}

// ─── Walk-forward driver ─────────────────────────────────────────────────────────

export function walkForward(candles, { isDays = 730, oosDays = 180, overlay = {} } = {}) {
  const n = candles.length;
  const windows = [];
  let isStart = 0;
  while (isStart + isDays + oosDays <= n) {
    const isSlice = candles.slice(isStart, isStart + isDays);

    // Optimise: highest OOS-proxy Sharpe on the in-sample slice.
    let best = null;
    for (const cfg of gridConfigs(overlay)) {
      const r = runBacktest(isSlice, cfg);
      if (r.nTrades < 3) continue;
      if (!best || r.sharpe > best.sharpe) best = { cfg, sharpe: r.sharpe };
    }
    const cfg = best ? best.cfg : { ...BASE_CFG, ...overlay };

    // Trade frozen params on IS+OOS (indicators warmed), measure OOS only.
    const oosStartDate = candles[isStart + isDays].date;
    const oosEndDate = candles[isStart + isDays + oosDays - 1].date;
    const combined = candles.slice(isStart, isStart + isDays + oosDays);
    const r = runBacktest(combined, cfg);
    const oosTrades = r.trades.filter((t) => t.date >= oosStartDate && t.date <= oosEndDate);

    let growth = 1;
    if (oosTrades.length) {
      const first = oosTrades[0], last = oosTrades[oosTrades.length - 1];
      const before = first.portfolio - first.pnl;
      growth = before > 0 ? last.portfolio / before : 1;
    }
    windows.push({ oosRange: `${oosStartDate}→${oosEndDate}`, cfg, growth, oosTrades: oosTrades.length });
    isStart += oosDays;
  }

  let stitched = 1000;
  const curve = [1000];
  for (const w of windows) { stitched *= w.growth; curve.push(stitched); }
  let peak = curve[0], maxDD = 0;
  for (const v of curve) { if (v > peak) peak = v; const dd = (peak - v) / peak; if (dd > maxDD) maxDD = dd; }
  const years = (windows.length * oosDays) / 365;
  const cagr = years > 0 && stitched > 0 ? Math.pow(stitched / 1000, 1 / years) - 1 : -1;
  const totalTrades = windows.reduce((s, w) => s + w.oosTrades, 0);

  return { windows, stitched, curve, maxDD, years, cagr, totalTrades };
}
