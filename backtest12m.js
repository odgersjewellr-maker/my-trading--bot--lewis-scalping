import { readFileSync } from "fs";

const lines = readFileSync("btc-daily-binance.csv", "utf8")
  .trim().split("\n").slice(1);

const allCandles = lines.map(l => {
  const [date, open, high, low, close, volume] = l.split(",");
  return { date: date.trim(), open: parseFloat(open), high: parseFloat(high), low: parseFloat(low), close: parseFloat(close), volume: parseFloat(volume) };
}).filter(c => !isNaN(c.close));

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

function calcADXSeries(candles, period = 14) {
  const n = candles.length;
  const plusDM = new Array(n).fill(null);
  const minusDM = new Array(n).fill(null);
  const tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const up = c.high - p.high, dn = p.low - c.low;
    plusDM[i]  = (up > dn && up > 0) ? up : 0;
    minusDM[i] = (dn > up && dn > 0) ? dn : 0;
  }
  const smTR = new Array(n).fill(null);
  const smP  = new Array(n).fill(null);
  const smM  = new Array(n).fill(null);
  let iTR = 0, iP = 0, iM = 0;
  for (let i = 1; i <= period; i++) { iTR += tr[i]; iP += plusDM[i]; iM += minusDM[i]; }
  smTR[period] = iTR; smP[period] = iP; smM[period] = iM;
  for (let i = period + 1; i < n; i++) {
    smTR[i] = smTR[i-1] - smTR[i-1]/period + tr[i];
    smP[i]  = smP[i-1]  - smP[i-1] /period + plusDM[i];
    smM[i]  = smM[i-1]  - smM[i-1] /period + minusDM[i];
  }
  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (!smTR[i]) continue;
    const pdi = 100 * smP[i] / smTR[i];
    const mdi = 100 * smM[i] / smTR[i];
    dx[i] = (pdi + mdi) > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
  }
  const adx = new Array(n).fill(null);
  const start = period * 2;
  if (start >= n) return adx;
  let sum = 0;
  for (let i = period; i < start; i++) sum += dx[i] ?? 0;
  adx[start - 1] = sum / period;
  for (let i = start; i < n; i++) adx[i] = (adx[i-1] * (period - 1) + (dx[i] ?? 0)) / period;
  return adx;
}

function calcStddevSeries(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1).map(v => v ?? 0);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    out[i] = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  }
  return out;
}

function calcNKBSeries(candles, cfg) {
  const closes = candles.map(c => c.close);
  const n = closes.length;
  const atrArr = calcATRSeries(candles, cfg.atrLen);
  const atrNorm = atrArr.map((a, i) => a != null ? a / closes[i] : null);
  const atrFactor = calcEMASeries(atrNorm, cfg.atrLen);
  const h = atrFactor.map(f => cfg.bandwidth * (cfg.adaptive ? 1 + (f ?? 0) * 200 : 1));

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

  const kernelArr = calcEMASeries(nwRaw, cfg.smooth);
  const residuals = closes.map((c, i) => kernelArr[i] != null ? c - kernelArr[i] : null);
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

function runBacktest(candles, cfg, label) {
  const { state, atrArr } = calcNKBSeries(candles, cfg);
  const adxArr = cfg.useADXHold ? calcADXSeries(candles, cfg.adxPeriod || 14) : null;
  const ADX_HOLD = cfg.adxHoldThreshold || 25;
  const n = candles.length;

  let portfolio = 1000;
  let position = null;
  let prevState = 0;
  let pendingSignal = null;
  let pendingBars = 0;
  const trades = [];

  for (let i = 1; i < n; i++) {
    const price = candles[i].close;
    const curState = state[i];
    const atr = atrArr[i];
    const date = candles[i].date;

    const flippedBull = curState === 1  && prevState !== 1;
    const flippedBear = curState === -1 && prevState !== -1;

    if (flippedBull)                 { pendingSignal = "BUY";  pendingBars = 1; }
    else if (flippedBear)            { pendingSignal = "SELL"; pendingBars = 1; }
    else if (curState === prevState) { pendingBars++; }
    else                             { pendingSignal = null; pendingBars = 0; }

    prevState = curState;

    const buySignal  = pendingSignal === "BUY"  && pendingBars >= cfg.confirmBars;
    const sellSignal = pendingSignal === "SELL" && pendingBars >= cfg.confirmBars;

    // Stop loss check
    if (position) {
      const hit = position.side === "long" ? price <= position.stop : price >= position.stop;
      if (hit) {
        const pnl = position.side === "long"
          ? (position.stop - position.entry) * position.qty
          : (position.entry - position.stop) * position.qty;
        portfolio += pnl;
        trades.push({ date, type: "stop", pnl });
        position = null; pendingSignal = null; pendingBars = 0;
      }
    }

    // ADX hold — stay in while trend is strong
    let adxHolding = false;
    if (adxArr && position) {
      const adxVal = adxArr[i];
      if (adxVal != null && adxVal >= ADX_HOLD) {
        if (position.side === "long"  && sellSignal) adxHolding = true;
        if (position.side === "short" && buySignal)  adxHolding = true;
      }
    }

    // Signal exit + flip (unless ADX says hold)
    if (!adxHolding && position && ((position.side === "long" && sellSignal) || (position.side === "short" && buySignal))) {
      const pnl = position.side === "long"
        ? (price - position.entry) * position.qty
        : (position.entry - price) * position.qty;
      portfolio += pnl;
      trades.push({ date, type: "signal", pnl });
      position = null;
    }

    // Open new position
    if (!position && (buySignal || sellSignal)) {
      const side = buySignal ? "long" : "short";
      const tradeSize = portfolio * cfg.tradeSizePct;
      const qty = tradeSize / price;
      const stopDist = atr ? atr * cfg.atrStopMult : price * 0.02;
      const stop = side === "long" ? price - stopDist : price + stopDist;
      position = { side, entry: price, qty, stop };
    }
  }

  if (position) {
    const price = candles[n - 1].close;
    const pnl = position.side === "long"
      ? (price - position.entry) * position.qty
      : (position.entry - price) * position.qty;
    portfolio += pnl;
    trades.push({ type: "end", pnl });
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const winRate = trades.length ? (wins.length / trades.length * 100).toFixed(1) : 0;
  const profitFactor = losses.length
    ? (wins.reduce((s,t) => s + t.pnl, 0) / Math.abs(losses.reduce((s,t) => s + t.pnl, 0))).toFixed(2)
    : "∞";

  console.log(`\n── ${label} ──`);
  console.log(`  Period:        ${candles[0].date} → ${candles[candles.length-1].date}`);
  console.log(`  Start:         $1,000`);
  console.log(`  End:           $${portfolio.toFixed(2)}`);
  console.log(`  Return:        $${totalPnl.toFixed(2)} (${((portfolio - 1000) / 10).toFixed(1)}%)`);
  console.log(`  Trades:        ${trades.length}`);
  console.log(`  Win rate:      ${winRate}%`);
  console.log(`  Profit factor: ${profitFactor}`);
  console.log(`  Best trade:    $${Math.max(...trades.map(t => t.pnl)).toFixed(2)}`);
  console.log(`  Worst trade:   $${Math.min(...trades.map(t => t.pnl)).toFixed(2)}`);

  return portfolio;
}

const CFG     = { length: 30, bandwidth: 10.0, adaptive: true, atrLen: 14, smooth: 3, bandMult: 1.5, bandLen: 24, bandSmooth: 5, atrStopMult: 1.5, confirmBars: 1, tradeSizePct: 0.80, useADXHold: false };
const CFG_ADX = { ...CFG, useADXHold: true, adxHoldThreshold: 25 };

function compareRun(candles, label) {
  const r1 = runBacktest(candles, CFG,     label + " — NKB only");
  const r2 = runBacktest(candles, CFG_ADX, label + " — NKB + ADX hold >25");
  const diff = ((r2 - r1) / r1 * 100).toFixed(1);
  console.log(`  → ADX hold adds ${diff > 0 ? "+" : ""}${diff}% vs NKB only\n`);
}

console.log("\n═══════════════════════════════════════════════════════════");
console.log("  NKB Expected Return — $1,000 invested");
console.log("  Comparing: NKB only  vs  NKB + ADX hold >25");
console.log("═══════════════════════════════════════════════════════════");

const cutoff12m = new Date("2025-07-01");
compareRun(allCandles.filter(c => new Date(c.date) >= cutoff12m), "Last 12 months (Jul 2025–Jun 2026)");

const cutoff24m = new Date("2024-07-01");
compareRun(allCandles.filter(c => new Date(c.date) >= cutoff24m), "Last 24 months (Jul 2024–Jun 2026)");

compareRun(allCandles.filter(c => new Date(c.date) >= new Date("2020-01-01") && new Date(c.date) <= new Date("2021-12-31")), "Bull market (2020–2021)");

compareRun(allCandles.filter(c => new Date(c.date) >= new Date("2022-01-01") && new Date(c.date) <= new Date("2022-12-31")), "Bear market (2022)");

compareRun(allCandles, "Full history (2018–2026)");

console.log("═══════════════════════════════════════════════════════════\n");
