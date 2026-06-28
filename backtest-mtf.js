// Multi-timeframe NKB confirmation backtest.
//
// Entries fire on a 5m NKB state flip, confirmed if EITHER the 15m or the 30m
// NKB state agrees with the 5m direction (OR logic). Exits fire the instant
// ANY one of the three timeframes flips against the open position. Uses the
// exact same Nadaraya-Watson kernel-regression math as bot.js's calcNKB() —
// copied here (not imported) because bot.js computes only the *final* bar's
// state, while a backtest needs the state at every historical bar.
//
// Data: real Binance 1m BTCUSDT klines dropped in backtest-data/ (Dec 2024,
// Apr/Jun/Aug/Dec 2025 — five non-contiguous months for variety). Binance
// switched some monthly archives from ms to microsecond open_time partway
// through 2025, so each row's timestamp is normalized by digit count below
// rather than assuming one fixed unit across all files.
//
// Usage: node backtest-mtf.js [kernel] [stopLossPct]
//   node backtest-mtf.js tricube 0.3

import { readFileSync, readdirSync } from "fs";
import path from "path";

const DATA_DIR = "backtest-data";
const KERNEL_NAME = (process.argv[2] || "tricube").toLowerCase();
const STOP_LOSS_PCT = parseFloat(process.argv[3] || "0.3");

const NKB = {
  length: 30,
  bandwidth: 8.0,
  adaptive: true,
  atrLen: 14,
  smooth: 3,
  bandMult: 1.0,
  bandLen: 24,
  bandSmooth: 5,
};

const KERNELS = {
  gaussian: (j, h) => Math.exp(-(j * j) / (2 * h * h)),
  epanechnikov: (j, h) => {
    const u = j / h;
    return Math.abs(u) > 1 ? 0 : 0.75 * (1 - u * u);
  },
  tricube: (j, h) => {
    const u = j / h;
    return Math.abs(u) > 1 ? 0 : (1 - Math.abs(u) ** 3) ** 3;
  },
};
const kernelFn = KERNELS[KERNEL_NAME];
if (!kernelFn) throw new Error(`Unknown kernel "${KERNEL_NAME}"`);

// ─── Load + parse 1m candles ──────────────────────────────────────────────

function loadCandles1m() {
  const files = readdirSync(DATA_DIR).filter((f) => f.endsWith(".csv")).sort();
  const candles = [];
  for (const file of files) {
    const text = readFileSync(path.join(DATA_DIR, file), "utf8");
    const lines = text.trim().split("\n");
    for (const line of lines) {
      const f = line.split(",");
      const rawTime = f[0];
      // 13-digit = ms, 16-digit = microseconds — normalize to ms.
      const timeMs = rawTime.length >= 16 ? Math.round(parseInt(rawTime) / 1000) : parseInt(rawTime);
      candles.push({
        time: timeMs,
        open: parseFloat(f[1]),
        high: parseFloat(f[2]),
        low: parseFloat(f[3]),
        close: parseFloat(f[4]),
        volume: parseFloat(f[5]),
      });
    }
  }
  candles.sort((a, b) => a.time - b.time);
  return candles;
}

function resample(candles1m, minutes) {
  const bucketMs = minutes * 60 * 1000;
  const out = [];
  let bucket = null;
  let bucketStart = null;
  for (const c of candles1m) {
    const start = Math.floor(c.time / bucketMs) * bucketMs;
    if (start !== bucketStart) {
      if (bucket) out.push(bucket);
      bucketStart = start;
      bucket = { time: start, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume += c.volume;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

// ─── NKB math (ported from bot.js, extended to return full state history) ──

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
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

// Returns { state: number[] } — the sticky lastState replayed at every bar
// (causal: state[i] depends only on candles[0..i], same as live).
function calcNKBStates(candles) {
  const closes = candles.map((c) => c.close);
  const n = closes.length;

  const atrArr = calcATRSeries(candles, NKB.atrLen);
  const atrNorm = atrArr.map((a, i) => (a != null ? a / closes[i] : null));
  const atrFactor = calcEMASeries(atrNorm, NKB.atrLen);
  const h = atrFactor.map((f) => NKB.bandwidth * (NKB.adaptive ? 1 + (f ?? 0) * 200 : 1));

  const nwRaw = new Array(n);
  for (let i = 0; i < n; i++) {
    const hi = h[i];
    let sumW = 0, sumWC = 0;
    const lookback = Math.min(NKB.length, i + 1);
    for (let j = 0; j < lookback; j++) {
      const kw = kernelFn(j, hi);
      sumWC += kw * closes[i - j];
      sumW += kw;
    }
    nwRaw[i] = sumW > 0 ? sumWC / sumW : closes[i];
  }

  const kernelArr = calcEMASeries(nwRaw, NKB.smooth);
  const residuals = closes.map((c, i) => (kernelArr[i] != null ? c - kernelArr[i] : null));
  const sigmaRawArr = calcStddevSeries(residuals, NKB.bandLen);
  const sigmaArr = calcEMASeries(sigmaRawArr, NKB.bandSmooth);

  const states = new Array(n).fill(0);
  let lastState = 0;
  for (let i = 0; i < n; i++) {
    if (kernelArr[i] == null || sigmaArr[i] == null) {
      states[i] = lastState;
      continue;
    }
    const upper = kernelArr[i] + NKB.bandMult * sigmaArr[i];
    const lower = kernelArr[i] - NKB.bandMult * sigmaArr[i];
    if (closes[i] > upper) lastState = 1;
    else if (closes[i] < lower) lastState = -1;
    states[i] = lastState;
  }
  return states;
}

// Aligns a higher-timeframe state series onto a lower-timeframe candle index:
// for each lower-TF bar, find the latest higher-TF bar whose close time is
// at or before it (i.e. the most recent *completed* higher-TF bar).
function alignStates(lowerCandles, higherCandles, higherStates) {
  const out = new Array(lowerCandles.length).fill(0);
  let hi = -1;
  for (let i = 0; i < lowerCandles.length; i++) {
    const t = lowerCandles[i].time;
    while (hi + 1 < higherCandles.length && higherCandles[hi + 1].time <= t) hi++;
    out[i] = hi >= 0 ? higherStates[hi] : 0;
  }
  return out;
}

// ─── Backtest engine ────────────────────────────────────────────────────────

function computeStopPrice(dir, entryPrice) {
  return dir === 1 ? entryPrice * (1 - STOP_LOSS_PCT / 100) : entryPrice * (1 + STOP_LOSS_PCT / 100);
}

function runBacktest(candles5, state5, state15Aligned, state30Aligned) {
  const trades = [];
  let position = null; // { dir, entryPrice, entryTime, stopPrice }
  let prevState5 = 0;
  const warmup = NKB.length + NKB.bandLen + NKB.bandSmooth; // let indicators stabilize

  for (let i = warmup; i < candles5.length; i++) {
    const bar = candles5[i];
    const s5 = state5[i];
    const s15 = state15Aligned[i];
    const s30 = state30Aligned[i];

    if (position) {
      const stopHit =
        position.dir === 1 ? bar.low <= position.stopPrice : bar.high >= position.stopPrice;
      const flippedAgainst =
        (s5 !== 0 && s5 !== position.dir) ||
        (s15 !== 0 && s15 !== position.dir) ||
        (s30 !== 0 && s30 !== position.dir);

      if (stopHit || flippedAgainst) {
        const exitPrice = stopHit ? position.stopPrice : bar.close;
        const pct =
          position.dir === 1
            ? (exitPrice - position.entryPrice) / position.entryPrice
            : (position.entryPrice - exitPrice) / position.entryPrice;
        trades.push({
          dir: position.dir,
          entryTime: position.entryTime,
          exitTime: bar.time,
          entryPrice: position.entryPrice,
          exitPrice,
          pct,
          reason: stopHit ? "stop" : "flip",
        });
        position = null;
      }
    }

    if (!position && s5 !== prevState5 && s5 !== 0) {
      const confirmed = s15 === s5 || s30 === s5;
      if (confirmed) {
        position = {
          dir: s5,
          entryPrice: bar.close,
          entryTime: bar.time,
          stopPrice: computeStopPrice(s5, bar.close),
        };
      }
    }
    prevState5 = s5;
  }
  return trades;
}

function summarize(trades) {
  const n = trades.length;
  if (n === 0) return { n: 0 };
  const wins = trades.filter((t) => t.pct > 0);
  const losses = trades.filter((t) => t.pct <= 0);
  const totalReturn = trades.reduce((acc, t) => acc * (1 + t.pct), 1) - 1;
  const grossWin = wins.reduce((s, t) => s + t.pct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pct, 0));

  let equity = 1, peak = 1, maxDD = 0;
  for (const t of trades) {
    equity *= 1 + t.pct;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
  }

  return {
    n,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / n) * 100,
    totalReturnPct: totalReturn * 100,
    avgReturnPct: (trades.reduce((s, t) => s + t.pct, 0) / n) * 100,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    maxDrawdownPct: maxDD * 100,
    stopExits: trades.filter((t) => t.reason === "stop").length,
    flipExits: trades.filter((t) => t.reason === "flip").length,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

console.log(`Loading 1m candles from ${DATA_DIR}/ ...`);
const candles1m = loadCandles1m();
console.log(`Loaded ${candles1m.length} 1m candles spanning ${new Date(candles1m[0].time).toISOString()} → ${new Date(candles1m.at(-1).time).toISOString()}`);

const candles5 = resample(candles1m, 5);
const candles15 = resample(candles1m, 15);
const candles30 = resample(candles1m, 30);
console.log(`Resampled: 5m=${candles5.length} 15m=${candles15.length} 30m=${candles30.length} bars`);
console.log(`Kernel: ${KERNEL_NAME}  |  Stop loss: ${STOP_LOSS_PCT}%\n`);

const state5 = calcNKBStates(candles5);
const state15 = calcNKBStates(candles15);
const state30 = calcNKBStates(candles30);

const state15Aligned = alignStates(candles5, candles15, state15);
const state30Aligned = alignStates(candles5, candles30, state30);

const trades = runBacktest(candles5, state5, state15Aligned, state30Aligned);
const stats = summarize(trades);

console.log("── Multi-timeframe NKB confirmation backtest ───────────────");
console.log(`Trades            : ${stats.n}`);
if (stats.n > 0) {
  console.log(`Win rate          : ${stats.winRate.toFixed(1)}% (${stats.wins}W / ${stats.losses}L)`);
  console.log(`Total return      : ${stats.totalReturnPct.toFixed(2)}% (compounded, no leverage/fees)`);
  console.log(`Avg return/trade  : ${stats.avgReturnPct.toFixed(3)}%`);
  console.log(`Profit factor     : ${stats.profitFactor.toFixed(2)}`);
  console.log(`Max drawdown      : ${stats.maxDrawdownPct.toFixed(2)}%`);
  console.log(`Exits via stop    : ${stats.stopExits}`);
  console.log(`Exits via flip    : ${stats.flipExits}`);
}
console.log("──────────────────────────────────────────────────────────\n");
