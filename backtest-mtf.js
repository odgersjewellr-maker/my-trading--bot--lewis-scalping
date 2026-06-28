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
// Usage: node backtest-mtf.js [kernel] [stopLossPct] [--trace N] [--smart-size]
//   node backtest-mtf.js tricube 0.3
//   node backtest-mtf.js tricube 0.3 --trace 10   (print first 10 trades'
//                                                   entry/exit reasoning so
//                                                   the confirmation/exit
//                                                   logic itself can be
//                                                   sanity-checked, not just
//                                                   the aggregate P&L)
//   node backtest-mtf.js tricube 0.3 --smart-size  (dynamic position weight
//                                                    from confirmation tier +
//                                                    conviction + volatility,
//                                                    plus a 50% scale-out the
//                                                    first time a fully-agreed
//                                                    trade sees one of 15m/30m
//                                                    disagree, before any full
//                                                    close)

import { readFileSync, readdirSync } from "fs";
import path from "path";

const DATA_DIR = "backtest-data";
const KERNEL_NAME = (process.argv[2] || "tricube").toLowerCase();
const STOP_LOSS_PCT = parseFloat(process.argv[3] || "0.3");
const traceIdx = process.argv.indexOf("--trace");
const TRACE_N = traceIdx !== -1 ? parseInt(process.argv[traceIdx + 1] || "10") : 0;
const exitModeIdx = process.argv.indexOf("--exit-mode");
// "any" = exit when ANY of 5m/15m/30m flips against the position (default).
// "5m"  = exit only when the 5m signal itself flips (15m/30m flips ignored).
const EXIT_MODE = exitModeIdx !== -1 ? process.argv[exitModeIdx + 1] : "any";
const confirmModeIdx = process.argv.indexOf("--confirm-mode");
// "or"  = either 15m or 30m agreeing is enough (default, current live logic).
// "and" = both 15m AND 30m must agree — fewer, higher-conviction entries.
const CONFIRM_MODE = confirmModeIdx !== -1 ? process.argv[confirmModeIdx + 1] : "or";
const convictionIdx = process.argv.indexOf("--conviction");
// Minimum sigma the 5m close must clear beyond the band edge at the flip
// bar before the signal counts as an entry — 0 = off (any crossing counts,
// current default), 0.5 = needs to clear the band by an extra half-sigma.
const CONVICTION = convictionIdx !== -1 ? parseFloat(process.argv[convictionIdx + 1]) : 0;
const trendTfIdx = process.argv.indexOf("--trend-tf");
// Higher-timeframe (minutes) trend filter — 0 = off (default). When set, an
// entry additionally requires this timeframe's NKB state to already agree
// with the 5m signal's direction (a *mandatory* gate, separate from the
// 15m/30m OR/AND confirmation, meant to block counter-trend noise).
const TREND_TF = trendTfIdx !== -1 ? parseInt(process.argv[trendTfIdx + 1]) : 0;
const takeProfitIdx = process.argv.indexOf("--take-profit");
// Fixed take-profit % from entry — 0 = off (default, winners only close on
// a flip/exit signal same as losers). When set, locks in the win the
// instant price reaches +TP%/-TP% from entry, regardless of NKB state.
const TAKE_PROFIT_PCT = takeProfitIdx !== -1 ? parseFloat(process.argv[takeProfitIdx + 1]) : 0;
const trailIdx = process.argv.indexOf("--trail-pct");
// Trailing stop % behind the favorable peak/trough since entry — 0 = off
// (default, fixed stop only). Once set, the stop ratchets in the trade's
// favor as price moves but never loosens, e.g. 0.3 means "stop sits 0.3%
// behind the best price seen so far," locking in gains as a trend runs.
const TRAIL_PCT = trailIdx !== -1 ? parseFloat(process.argv[trailIdx + 1]) : 0;
// --smart-size combines a per-trade weight (fraction of standard capital
// risked) with an early de-risk exit. Off by default — every trade risks a
// flat 1.0x weight and only fully closes on a real flip, matching every
// prior backtest run.
const SMART_SIZE = process.argv.includes("--smart-size");
// Tunable knobs for the smart-size formula, exposed so they can be swept
// from the CLI instead of edited in source.
//
// Two earlier formulas were tried and rejected by backtest before landing on
// these defaults:
//   1. Letting weight exceed 1.0 on strong confirmation/conviction/low-vol
//      ("size up when everything agrees") just added implicit leverage —
//      return and max drawdown rose together, and the return/drawdown ratio
//      ended up *worse* than flat 1x sizing (e.g. 54.69%/11.69% vs the flat
//      baseline's 52.15%/8.49% — ratio 4.68 vs 6.14).
//   2. A volatility-based multiplier (inverse of ATR-normalized vol vs its
//      own trailing average) was tested at every tried strength and always
//      made the return/drawdown ratio worse, never better — so it's wired
//      in but disabled by default (--size-vol-min/-max both default to 1.0,
//      a no-op) rather than removed, since the flag is there to sweep.
// What DID help, confirmed by sweep: (a) sizing down — never up — on weak
// confirmation/conviction, capped at a 1.0 ceiling, and (b) fully closing
// (not partially scaling out) the instant a fully-agreed trade sees its
// first 15m/30m disagreement, rather than waiting for a second disagreement
// or the 5m flip itself. That combination (defaults below) beat flat sizing
// on every axis: 52.60% return / 6.96% drawdown / 1.41 profit factor vs the
// flat baseline's 52.15% / 8.49% / 1.33 — ratio 7.56 vs 6.14.
function flagFloat(name, def) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? parseFloat(process.argv[idx + 1]) : def;
}
const SIZE_BASE_PARTIAL = flagFloat("--size-base-partial", 0.5); // weight tier when only 1 of 15m/30m agrees
const SIZE_CONV_COEF = flagFloat("--size-conv-coef", 0.2); // sigma-strength needed to reach full (1.0) weight
const SIZE_CONV_MIN = flagFloat("--size-conv-min", 0.6);
const SIZE_CONV_MAX = flagFloat("--size-conv-max", 1.0);
const SIZE_VOL_MIN = flagFloat("--size-vol-min", 1.0); // disabled by default — see note above
const SIZE_VOL_MAX = flagFloat("--size-vol-max", 1.0);
const SIZE_WEIGHT_MIN = flagFloat("--size-weight-min", 0.3);
const SIZE_WEIGHT_MAX = flagFloat("--size-weight-max", 1.0);
const SIZE_SCALEOUT_FRAC = flagFloat("--size-scaleout-frac", 1.0); // fraction of weight shed on first disagreement (1.0 = full close)

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
  // Conviction: how many sigma beyond the *opposite* band the close currently
  // sits — e.g. strength=0 means just touching the band edge (bandMult), 0.5
  // means half a sigma further out than that. Used to filter marginal,
  // barely-crossed-the-line signals from genuine breakouts.
  const strength = new Array(n).fill(0);
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
    if (sigmaArr[i] > 0) {
      strength[i] =
        lastState === 1
          ? (closes[i] - upper) / sigmaArr[i]
          : lastState === -1
            ? (lower - closes[i]) / sigmaArr[i]
            : 0;
    }
  }
  return { states, strength, atrNorm };
}

// Sizing multiplier from recent ATR-normalized volatility, relative to its
// own trailing average: below-average vol -> bigger size (cap 1.5x),
// above-average vol -> smaller size (floor 0.5x). A simple vol-targeting
// proxy, not a calibrated risk model.
function calcVolMultiplier(atrNorm, period = 100) {
  const out = new Array(atrNorm.length).fill(1);
  for (let i = 0; i < atrNorm.length; i++) {
    if (atrNorm[i] == null) continue;
    const start = Math.max(0, i - period + 1);
    const window = atrNorm.slice(start, i + 1).filter((v) => v != null);
    if (window.length < 10) continue;
    const avg = window.reduce((a, b) => a + b, 0) / window.length;
    if (avg <= 0) continue;
    out[i] = Math.min(SIZE_VOL_MAX, Math.max(SIZE_VOL_MIN, avg / atrNorm[i]));
  }
  return out;
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

function computeTakeProfitPrice(dir, entryPrice) {
  return dir === 1 ? entryPrice * (1 + TAKE_PROFIT_PCT / 100) : entryPrice * (1 - TAKE_PROFIT_PCT / 100);
}

// Composite sizing weight at entry, gated entirely behind SMART_SIZE: base
// tier from confirmation strength (both 15m+30m agree -> full size, only one
// -> reduced), times a conviction multiplier from the 5m strength reading at
// the flip bar, times the volatility multiplier. Clamped to a sane range so
// one extreme reading can't blow up position size.
function computeWeight(confirmedBy, strengthAtFlip, volMult) {
  const base = confirmedBy.length === 2 ? 1.0 : SIZE_BASE_PARTIAL;
  // Weak signals (low sigma-strength at the flip) shrink size toward
  // SIZE_CONV_MIN; strong signals (>= SIZE_CONV_COEF sigma) reach full (1.0)
  // weight — but never above it, so conviction can only de-risk a trade.
  const convictionMult = Math.min(SIZE_CONV_MAX, Math.max(SIZE_CONV_MIN, strengthAtFlip / SIZE_CONV_COEF));
  const vol = volMult ?? 1;
  return Math.min(SIZE_WEIGHT_MAX, Math.max(SIZE_WEIGHT_MIN, base * convictionMult * vol));
}

function runBacktest(candles5, state5, state15Aligned, state30Aligned, strength5, trendAligned, volMult5) {
  const trades = [];
  let position = null; // { dir, entryPrice, entryTime, stopPrice, weight, fullyAgreed, scaledOut }
  let prevState5 = 0;
  const warmup = NKB.length + NKB.bandLen + NKB.bandSmooth; // let indicators stabilize

  for (let i = warmup; i < candles5.length; i++) {
    const bar = candles5[i];
    const s5 = state5[i];
    const s15 = state15Aligned[i];
    const s30 = state30Aligned[i];

    if (position) {
      // Ratchet the stop toward the favorable extreme seen this bar — never
      // loosens. Using the same bar's high/low to both tighten the trail and
      // then test for a stop-out is a known bar-based-backtest approximation
      // (a real trailing stop updates continuously intrabar); it can look
      // slightly optimistic on bars with a wide range in the trade's favor.
      if (TRAIL_PCT > 0) {
        position.stopPrice =
          position.dir === 1
            ? Math.max(position.stopPrice, bar.high * (1 - TRAIL_PCT / 100))
            : Math.min(position.stopPrice, bar.low * (1 + TRAIL_PCT / 100));
      }

      // Conservative ordering: if a bar's range covers both the stop and the
      // take-profit, assume the stop hit first (can't know intrabar path
      // from OHLC alone, so don't credit the best-case outcome).
      const stopHit =
        position.dir === 1 ? bar.low <= position.stopPrice : bar.high >= position.stopPrice;
      const tpHit =
        TAKE_PROFIT_PCT > 0 && !stopHit &&
        (position.dir === 1 ? bar.high >= position.tpPrice : bar.low <= position.tpPrice);
      const flippedBy = [];
      if (s5 !== 0 && s5 !== position.dir) flippedBy.push("5m");
      if (EXIT_MODE === "any") {
        if (s15 !== 0 && s15 !== position.dir) flippedBy.push("15m");
        if (s30 !== 0 && s30 !== position.dir) flippedBy.push("30m");
      }

      const isHardExit = stopHit || tpHit || flippedBy.includes("5m");
      const softFlipCount = flippedBy.filter((f) => f !== "5m").length;

      if (SMART_SIZE && position.fullyAgreed && !position.scaledOut && !isHardExit && softFlipCount === 1) {
        // First disagreement on a fully-agreed trade: scale OUT half the
        // remaining weight at the current mark instead of closing fully —
        // the original full-confirmation thesis isn't dead yet, just weaker.
        const exitPrice = bar.close;
        const pct =
          position.dir === 1
            ? (exitPrice - position.entryPrice) / position.entryPrice
            : (position.entryPrice - exitPrice) / position.entryPrice;
        const scaleWeight = position.weight * SIZE_SCALEOUT_FRAC;
        trades.push({
          dir: position.dir,
          entryTime: position.entryTime,
          exitTime: bar.time,
          entryPrice: position.entryPrice,
          exitPrice,
          pct,
          weight: scaleWeight,
          reason: "scale-out",
          confirmedBy: position.confirmedBy,
          flippedBy,
        });
        position.weight -= scaleWeight;
        position.scaledOut = true;
      } else if (stopHit || tpHit || flippedBy.length > 0) {
        const exitPrice = stopHit ? position.stopPrice : tpHit ? position.tpPrice : bar.close;
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
          weight: position.weight,
          reason: stopHit ? "stop" : tpHit ? "take-profit" : "flip",
          confirmedBy: position.confirmedBy,
          flippedBy: stopHit || tpHit ? [] : flippedBy,
        });
        position = null;
      }
    }

    if (!position && s5 !== prevState5 && s5 !== 0) {
      const confirmedBy = [];
      if (s15 === s5) confirmedBy.push("15m");
      if (s30 === s5) confirmedBy.push("30m");
      const confirmed = CONFIRM_MODE === "and" ? confirmedBy.length === 2 : confirmedBy.length > 0;
      const convictionMet = strength5[i] >= CONVICTION;
      const trendOk = TREND_TF === 0 || (trendAligned[i] !== 0 && trendAligned[i] === s5);

      if (confirmed && convictionMet && trendOk) {
        position = {
          dir: s5,
          entryPrice: bar.close,
          entryTime: bar.time,
          confirmedBy,
          stopPrice: computeStopPrice(s5, bar.close),
          tpPrice: TAKE_PROFIT_PCT > 0 ? computeTakeProfitPrice(s5, bar.close) : null,
          weight: SMART_SIZE ? computeWeight(confirmedBy, strength5[i], volMult5 ? volMult5[i] : 1) : 1,
          fullyAgreed: confirmedBy.length === 2,
          scaledOut: false,
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
  // weight defaults to 1 so every pre-smart-sizing trade record (and every
  // run with --smart-size absent) compounds exactly as before.
  const w = (t) => t.weight ?? 1;
  const wins = trades.filter((t) => t.pct > 0);
  const losses = trades.filter((t) => t.pct <= 0);
  const totalReturn = trades.reduce((acc, t) => acc * (1 + t.pct * w(t)), 1) - 1;
  const grossWin = wins.reduce((s, t) => s + t.pct * w(t), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pct * w(t), 0));

  let equity = 1, peak = 1, maxDD = 0;
  for (const t of trades) {
    equity *= 1 + t.pct * w(t);
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
    tpExits: trades.filter((t) => t.reason === "take-profit").length,
    scaleOutExits: trades.filter((t) => t.reason === "scale-out").length,
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
console.log(
  `Kernel: ${KERNEL_NAME}  |  Stop loss: ${STOP_LOSS_PCT}%  |  Exit mode: ${EXIT_MODE}  |  Confirm mode: ${CONFIRM_MODE}` +
  (TREND_TF > 0 ? `  |  Trend filter: ${TREND_TF}m` : "") +
  (TAKE_PROFIT_PCT > 0 ? `  |  Take profit: ${TAKE_PROFIT_PCT}%` : "") +
  (TRAIL_PCT > 0 ? `  |  Trailing stop: ${TRAIL_PCT}%` : "") +
  (SMART_SIZE ? `  |  Smart sizing: on` : "") + "\n",
);

const { states: state5, strength: strength5, atrNorm: atrNorm5 } = calcNKBStates(candles5);
const { states: state15 } = calcNKBStates(candles15);
const { states: state30 } = calcNKBStates(candles30);

const state15Aligned = alignStates(candles5, candles15, state15);
const state30Aligned = alignStates(candles5, candles30, state30);
const volMult5 = SMART_SIZE ? calcVolMultiplier(atrNorm5) : null;

let trendAligned = null;
if (TREND_TF > 0) {
  const candlesTrend = resample(candles1m, TREND_TF);
  const { states: stateTrend } = calcNKBStates(candlesTrend);
  trendAligned = alignStates(candles5, candlesTrend, stateTrend);
}

const trades = runBacktest(candles5, state5, state15Aligned, state30Aligned, strength5, trendAligned, volMult5);
const stats = summarize(trades);

// candles1m.length / 1440, not (lastTime - firstTime), since the 5 months
// are non-contiguous — using the calendar span would count the gap months
// between them as "trading days" and understate trades/day.
const days = candles1m.length / 1440;

console.log("── Multi-timeframe NKB confirmation backtest ───────────────");
console.log(`Trades            : ${stats.n}  (≈${(stats.n / days).toFixed(1)}/day over ${days.toFixed(0)} days)`);
if (stats.n > 0) {
  console.log(`Win rate          : ${stats.winRate.toFixed(1)}% (${stats.wins}W / ${stats.losses}L)`);
  console.log(`Total return      : ${stats.totalReturnPct.toFixed(2)}% (compounded, no leverage/fees)`);
  console.log(`Avg return/trade  : ${stats.avgReturnPct.toFixed(3)}%`);
  console.log(`Profit factor     : ${stats.profitFactor.toFixed(2)}`);
  console.log(`Max drawdown      : ${stats.maxDrawdownPct.toFixed(2)}%`);
  console.log(`Exits via stop    : ${stats.stopExits}`);
  console.log(`Exits via flip    : ${stats.flipExits}`);
  console.log(`Exits via TP      : ${stats.tpExits}`);
  if (SMART_SIZE) console.log(`Scale-out exits   : ${stats.scaleOutExits}`);
}
console.log("──────────────────────────────────────────────────────────\n");

if (TRACE_N > 0) {
  console.log(`── Logic trace: first ${Math.min(TRACE_N, trades.length)} trades ──────────────\n`);
  for (const t of trades.slice(0, TRACE_N)) {
    const dirLabel = t.dir === 1 ? "LONG" : "SHORT";
    console.log(
      `${dirLabel.padEnd(5)} entry ${new Date(t.entryTime).toISOString()} @ ${t.entryPrice.toFixed(2)}` +
      ` | confirmed by: ${t.confirmedBy.join(", ")}`,
    );
    console.log(
      `      exit  ${new Date(t.exitTime).toISOString()} @ ${t.exitPrice.toFixed(2)}` +
      ` | reason: ${t.reason}${t.flippedBy.length ? ` (${t.flippedBy.join(", ")} flipped against)` : ""}` +
      ` | pnl: ${(t.pct * 100).toFixed(3)}%\n`,
    );
  }
}
