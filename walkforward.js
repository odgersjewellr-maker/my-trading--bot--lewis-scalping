/**
 * NKB Walk-Forward + Fee Test — honest out-of-sample validation.
 *
 * Usage: node walkforward.js [csv-path]
 *   FEE_RATE=0.0006 SLIPPAGE=0.0005 IS_DAYS=730 OOS_DAYS=180 node walkforward.js
 *
 * Why this exists:
 *   backtest.js --optimize picks the best parameters on the SAME data it scores
 *   them on (in-sample overfitting) and models ZERO trading cost. Both flatter the
 *   result. This script answers the only question that matters before risking money:
 *   does the edge survive (a) realistic fees + slippage and (b) being chosen on the
 *   past and traded on the future it never saw?
 *
 *   It does that by walk-forward analysis: optimise on a rolling in-sample (IS)
 *   window, then trade the immediately following out-of-sample (OOS) window with
 *   those frozen parameters, roll forward, and stitch every OOS segment into one
 *   continuous equity curve. That stitched curve is the honest estimate of what you
 *   would actually have earned trading this strategy forward in real time.
 *
 * The signal engine (indicators + runBacktest) is a faithful mirror of backtest.js,
 * with one addition: runBacktest here charges cfg.feeRate + cfg.slippage on the
 * notional of every entry and exit fill.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// ─── Config (env-overridable) ──────────────────────────────────────────────────

const FEE_RATE = parseFloat(process.env.FEE_RATE || "0.0006");   // taker fee per side (BitGet ≈ 0.06%)
const SLIPPAGE = parseFloat(process.env.SLIPPAGE || "0.0005");   // adverse fill per side (≈ 0.05%)
const IS_DAYS  = parseInt(process.env.IS_DAYS  || "730", 10);    // in-sample window (optimise here)
const OOS_DAYS = parseInt(process.env.OOS_DAYS || "180", 10);    // out-of-sample window (trade here)

const csvPath = process.argv.filter((a) => !a.startsWith("--"))[2] || "btc-daily-binance.csv";

// ─── Load CSV ───────────────────────────────────────────────────────────────────

const lines = readFileSync(resolve(csvPath), "utf8").trim().split("\n").slice(1);
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
  .filter((c) => !isNaN(c.close));

// ─── Indicator helpers (mirror of backtest.js) ──────────────────────────────────

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

function calcADXSeries(candles, period = 14) {
  const n = candles.length;
  const plusDM = new Array(n).fill(null);
  const minusDM = new Array(n).fill(null);
  const tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    plusDM[i] = (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM[i] = (downMove > upMove && downMove > 0) ? downMove : 0;
  }
  const smTR = new Array(n).fill(null);
  const smPlus = new Array(n).fill(null);
  const smMinus = new Array(n).fill(null);
  let initTR = 0, initPlus = 0, initMinus = 0;
  for (let i = 1; i <= period; i++) { initTR += tr[i]; initPlus += plusDM[i]; initMinus += minusDM[i]; }
  smTR[period] = initTR; smPlus[period] = initPlus; smMinus[period] = initMinus;
  for (let i = period + 1; i < n; i++) {
    smTR[i] = smTR[i - 1] - smTR[i - 1] / period + tr[i];
    smPlus[i] = smPlus[i - 1] - smPlus[i - 1] / period + plusDM[i];
    smMinus[i] = smMinus[i - 1] - smMinus[i - 1] / period + minusDM[i];
  }
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (!smTR[i]) continue;
    plusDI[i] = 100 * smPlus[i] / smTR[i];
    minusDI[i] = 100 * smMinus[i] / smTR[i];
    const diSum = plusDI[i] + minusDI[i];
    dx[i] = diSum > 0 ? 100 * Math.abs(plusDI[i] - minusDI[i]) / diSum : 0;
  }
  const adx = new Array(n).fill(null);
  const start = period * 2;
  if (start >= n) return { adx, plusDI, minusDI };
  let sumDX = 0;
  for (let i = period; i < start; i++) sumDX += dx[i] ?? 0;
  adx[start - 1] = sumDX / period;
  for (let i = start; i < n; i++) adx[i] = (adx[i - 1] * (period - 1) + (dx[i] ?? 0)) / period;
  return { adx, plusDI, minusDI };
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

  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (kernelArr[i] == null || sigmaArr[i] == null) continue;
    upper[i] = kernelArr[i] + cfg.bandMult * sigmaArr[i];
    lower[i] = kernelArr[i] - cfg.bandMult * sigmaArr[i];
  }

  const state = new Array(n).fill(0);
  let lastState = 0;
  for (let i = 0; i < n; i++) {
    if (upper[i] == null) { state[i] = lastState; continue; }
    if (closes[i] > upper[i]) lastState = 1;
    else if (closes[i] < lower[i]) lastState = -1;
    state[i] = lastState;
  }

  return { upper, lower, state, atrArr };
}

// ─── Fee-aware backtest engine (mirror of backtest.js + trading costs) ───────────

function runBacktest(candles, cfg) {
  const { state, atrArr } = calcNKBSeries(candles, cfg);
  const adxData = cfg.useADXHold ? calcADXSeries(candles, cfg.adxPeriod || 14) : null;
  const ADX_HOLD = cfg.adxHoldThreshold || 25;
  const costRate = (cfg.feeRate ?? 0) + (cfg.slippage ?? 0); // charged per side, on notional
  const n = candles.length;

  let portfolio = 1000;
  let position = null;
  let prevState = 0;
  let pendingSignal = null;
  let pendingBars = 0;

  const trades = [];
  const equity = [{ date: candles[0].date, value: portfolio }];

  // Charge one side's cost on a fill of `notional` dollars.
  const fill = (notional) => notional * costRate;

  for (let i = 1; i < n; i++) {
    const price = candles[i].close;
    const curState = state[i];
    const atr = atrArr[i];
    const date = candles[i].date;

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
        let pnl = position.side === "long"
          ? (position.stop - position.entry) * position.qty
          : (position.entry - position.stop) * position.qty;
        pnl -= fill(position.stop * position.qty); // exit fee
        portfolio += pnl;
        trades.push({ date, type: "stop", side: position.side, pnl, portfolio });
        position = null;
        pendingSignal = null; pendingBars = 0;
      }
    }

    // ADX hold — stay in trade while trend still strong
    let holding = false;
    if (cfg.useADXHold && adxData && position) {
      const adxVal = adxData.adx[i];
      if (adxVal != null && adxVal >= ADX_HOLD) {
        if (position.side === "long" && sellSignal) holding = true;
        if (position.side === "short" && buySignal) holding = true;
      }
    }

    // Close + flip on opposing NKB signal
    if (!holding && position && ((position.side === "long" && sellSignal) || (position.side === "short" && buySignal))) {
      let pnl = position.side === "long"
        ? (price - position.entry) * position.qty
        : (position.entry - price) * position.qty;
      pnl -= fill(price * position.qty); // exit fee
      portfolio += pnl;
      trades.push({ date, type: "signal", side: position.side, pnl, portfolio });
      position = null;
    }

    // Open new position
    if (!position && (buySignal || sellSignal)) {
      const side = buySignal ? "long" : "short";
      const tradeSize = portfolio * cfg.tradeSizePct;
      const qty = tradeSize / price;
      const stopDist = atr ? atr * cfg.atrStopMult : price * 0.02;
      const stop = side === "long" ? price - stopDist : price + stopDist;
      const entryFee = fill(tradeSize); // entry cost paid immediately
      portfolio -= entryFee;
      position = { side, entry: price, qty, stop };
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
    let pnl = position.side === "long"
      ? (price - position.entry) * position.qty
      : (position.entry - price) * position.qty;
    pnl -= fill(price * position.qty);
    portfolio += pnl;
    trades.push({ date: candles[n - 1].date, type: "end", side: position.side, pnl, portfolio });
  }

  return { portfolio, trades, equity, ...stats(trades, equity) };
}

function stats(trades, equity) {
  const exits = trades.filter((t) => t.pnl !== undefined);
  const wins = exits.filter((t) => t.pnl > 0);
  const losses = exits.filter((t) => t.pnl <= 0);
  const winRate = exits.length ? (wins.length / exits.length * 100) : 0;
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;

  let peak = equity[0].value, maxDD = 0;
  for (const e of equity) {
    if (e.value > peak) peak = e.value;
    const dd = peak > 0 ? (peak - e.value) / peak * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const rets = equity.slice(1).map((e, i) => (e.value - equity[i].value) / (equity[i].value || 1));
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const std = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(365) : 0;

  return { nTrades: exits.length, winRate, profitFactor, maxDD, sharpe };
}

// ─── Parameter grid (mirrors backtest.js --optimize, plus the ADX-hold variants) ──

const BASE_CFG = {
  length: 30, bandwidth: 10.0, adaptive: true, atrLen: 14,
  smooth: 3, bandMult: 1.5, bandLen: 24, bandSmooth: 5,
  atrStopMult: 1.5, confirmBars: 1, tradeSizePct: 0.80,
  usePOC: false,
  feeRate: FEE_RATE, slippage: SLIPPAGE,
};

function* grid() {
  for (const bandMult of [1.5, 2.0, 2.5, 3.0])
    for (const bandwidth of [6, 10, 14])
      for (const atrStopMult of [1.0, 1.5, 2.0, 3.0])
        for (const confirmBars of [1, 2])
          for (const adx of [{ useADXHold: false }, { useADXHold: true, adxHoldThreshold: 25 }])
            yield { ...BASE_CFG, bandMult, bandwidth, atrStopMult, confirmBars, ...adx };
}

// Pick the highest-Sharpe config on a given (in-sample) slice.
function optimise(slice) {
  let best = null;
  for (const cfg of grid()) {
    const r = runBacktest(slice, cfg);
    if (r.nTrades < 3) continue; // ignore configs that barely trade in-sample
    if (!best || r.sharpe > best.sharpe) best = { cfg, sharpe: r.sharpe };
  }
  // Fallback: if nothing traded enough, use the base config.
  return best ? best.cfg : BASE_CFG;
}

// ─── Walk-forward ────────────────────────────────────────────────────────────────

function walkForward() {
  const n = candles.length;
  const windows = [];
  let isStart = 0;
  while (isStart + IS_DAYS + OOS_DAYS <= n) {
    const isSlice = candles.slice(isStart, isStart + IS_DAYS);
    const oosStartDate = candles[isStart + IS_DAYS].date;
    const oosEndDate = candles[isStart + IS_DAYS + OOS_DAYS - 1].date;

    const cfg = optimise(isSlice);

    // Trade the frozen cfg on IS+OOS contiguous data (indicators stay warmed),
    // but measure ONLY the OOS segment. The OOS growth factor is scale-invariant,
    // so the compounded IS gains cancel out of the ratio.
    const combined = candles.slice(isStart, isStart + IS_DAYS + OOS_DAYS);
    const r = runBacktest(combined, cfg);
    const oosTrades = r.trades.filter((t) => t.date >= oosStartDate && t.date <= oosEndDate);

    let growth = 1;
    if (oosTrades.length) {
      const first = oosTrades[0];
      const last = oosTrades[oosTrades.length - 1];
      const equityBefore = first.portfolio - first.pnl;
      growth = equityBefore > 0 ? last.portfolio / equityBefore : 1;
    }

    windows.push({
      isRange: `${isSlice[0].date}→${isSlice[isSlice.length - 1].date}`,
      oosRange: `${oosStartDate}→${oosEndDate}`,
      cfg, growth, oosTrades: oosTrades.length,
    });
    isStart += OOS_DAYS;
  }
  return windows;
}

// ─── Report ──────────────────────────────────────────────────────────────────────

const pct = (x) => `${(x >= 0 ? "+" : "")}${(x * 100).toFixed(1)}%`;
const money = (x) => `$${x.toFixed(0)}`;

console.log("\n═══════════════════════════════════════════════════════════════════════");
console.log("  NKB WALK-FORWARD + FEE TEST");
console.log("═══════════════════════════════════════════════════════════════════════");
console.log(`  Data:  ${candles[0].date} → ${candles[candles.length - 1].date}  (${candles.length} daily bars)`);
console.log(`  Costs: ${(FEE_RATE * 100).toFixed(3)}% fee + ${(SLIPPAGE * 100).toFixed(3)}% slippage per side  (round-trip ≈ ${((FEE_RATE + SLIPPAGE) * 2 * 100).toFixed(2)}% of notional)`);
console.log(`  Windows: ${IS_DAYS}d in-sample (optimise) → ${OOS_DAYS}d out-of-sample (trade), rolling\n`);

// 1) Full-sample, best-variant, with vs without fees — shows the pure fee drag.
const fullNoFee = runBacktest(candles, { ...BASE_CFG, useADXHold: true, adxHoldThreshold: 25, feeRate: 0, slippage: 0 });
const fullFee   = runBacktest(candles, { ...BASE_CFG, useADXHold: true, adxHoldThreshold: 25 });
console.log("── 1. Fee drag (same params, full sample, ADX-hold>25) ────────────────");
console.log(`  ${"".padEnd(14)} ${"Final".padStart(10)} ${"Return".padStart(10)} ${"Trades".padStart(7)} ${"MaxDD".padStart(7)} ${"Sharpe".padStart(7)}`);
console.log(`  ${"no fees".padEnd(14)} ${money(fullNoFee.portfolio).padStart(10)} ${pct((fullNoFee.portfolio - 1000) / 1000).padStart(10)} ${String(fullNoFee.nTrades).padStart(7)} ${(fullNoFee.maxDD.toFixed(0) + "%").padStart(7)} ${fullNoFee.sharpe.toFixed(2).padStart(7)}`);
console.log(`  ${"WITH fees".padEnd(14)} ${money(fullFee.portfolio).padStart(10)} ${pct((fullFee.portfolio - 1000) / 1000).padStart(10)} ${String(fullFee.nTrades).padStart(7)} ${(fullFee.maxDD.toFixed(0) + "%").padStart(7)} ${fullFee.sharpe.toFixed(2).padStart(7)}`);
console.log(`  → fees alone cut the final balance by ${pct((fullFee.portfolio - fullNoFee.portfolio) / fullNoFee.portfolio)}\n`);

// 2) Walk-forward: the honest out-of-sample result.
const windows = walkForward();
console.log("── 2. Walk-forward windows (params chosen on IS, traded on OOS w/ fees) ─");
console.log(`  ${"OOS period".padEnd(23)} ${"chosen params".padEnd(34)} ${"trades".padStart(6)} ${"OOS ret".padStart(9)}`);
let stitched = 1000;
const oosCurve = [1000];
for (const w of windows) {
  stitched *= w.growth;
  oosCurve.push(stitched);
  const p = `bm${w.cfg.bandMult} bw${w.cfg.bandwidth} stop${w.cfg.atrStopMult} cb${w.cfg.confirmBars} adx${w.cfg.useADXHold ? w.cfg.adxHoldThreshold : "off"}`;
  console.log(`  ${w.oosRange.padEnd(23)} ${p.padEnd(34)} ${String(w.oosTrades).padStart(6)} ${pct(w.growth - 1).padStart(9)}`);
}

// Stitched OOS drawdown
let peak = oosCurve[0], oosMaxDD = 0;
for (const v of oosCurve) { if (v > peak) peak = v; const dd = (peak - v) / peak; if (dd > oosMaxDD) oosMaxDD = dd; }
const years = (windows.length * OOS_DAYS) / 365;
const cagr = years > 0 ? Math.pow(stitched / 1000, 1 / years) - 1 : 0;

console.log("\n── 3. VERDICT ─────────────────────────────────────────────────────────");
console.log(`  In-sample-optimised full run (the flattering number): ${money(fullNoFee.portfolio)}  (${pct((fullNoFee.portfolio - 1000) / 1000)})`);
console.log(`  Same, with realistic fees:                            ${money(fullFee.portfolio)}  (${pct((fullFee.portfolio - 1000) / 1000)})`);
console.log(`  HONEST walk-forward OOS, with fees:                   ${money(stitched)}  (${pct((stitched - 1000) / 1000)})`);
console.log(`    over ${years.toFixed(1)} yrs traded out-of-sample  →  ${pct(cagr)} / yr  |  OOS max drawdown ${(oosMaxDD * 100).toFixed(0)}%`);
const toTarget = stitched > 1000 && cagr > 0 ? Math.log(100) / Math.log(1 + cagr) : Infinity;
console.log(`    at this OOS rate, $1k → $100k takes ${isFinite(toTarget) ? toTarget.toFixed(1) + " years" : "→ never (edge does not compound)"}`);
console.log("═══════════════════════════════════════════════════════════════════════\n");
