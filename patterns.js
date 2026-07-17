/**
 * patterns.js — candlestick pattern recognition library.
 *
 * Every pattern is a named detector over an array of candles
 * ({date, open, high, low, close, volume}). Detectors are pure: they look at
 * candle i (and back), never forward — safe for live use on a closed candle.
 *
 * Usage:
 *   import { buildContext, detectAt, PATTERNS } from "./patterns.js";
 *   const ctx = buildContext(candles);          // precompute indicators once
 *   const fired = detectAt(ctx, candles.length - 1); // ids firing on last candle
 *
 * Pattern ids are referenced by pattern-rules.json (the if-this-then-that
 * layer) and scored historically by pattern-backtest.js.
 */

// ── candle helpers ───────────────────────────────────────────────────────────
export const green = (c) => c.close > c.open;
export const red = (c) => c.close < c.open;
export const body = (c) => Math.abs(c.close - c.open);
export const range = (c) => c.high - c.low || 1e-9;
export const upperWick = (c) => c.high - Math.max(c.open, c.close);
export const lowerWick = (c) => Math.min(c.open, c.close) - c.low;

// ── indicators (arrays aligned to candles; null until enough history) ────────
export function sma(candles, n) {
  const out = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].close;
    if (i >= n) sum -= candles[i - n].close;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(candles, n) {
  const out = new Array(candles.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < candles.length; i++) {
    prev = prev === null ? candles[i].close : candles[i].close * k + prev * (1 - k);
    if (i >= n - 1) out[i] = prev;
  }
  return out;
}

export function rsi(candles, n) {
  const out = new Array(candles.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < candles.length; i++) {
    const ch = candles[i].close - candles[i - 1].close;
    const gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
    if (i <= n) {
      avgGain += gain / n; avgLoss += loss / n;
      if (i === n) out[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-9));
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
      out[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-9));
    }
  }
  return out;
}

/**
 * Rolling volatility percentile: today's 20-candle average range, ranked
 * against the trailing 250 candles. Causal (only looks back) — live-safe.
 */
export function volRank(candles, span = 20, lookback = 250) {
  const v = candles.map((c, i) => {
    if (i < span) return null;
    let s = 0;
    for (let j = i - span + 1; j <= i; j++) s += (candles[j].high - candles[j].low) / candles[j].close;
    return s / span;
  });
  return v.map((cur, i) => {
    if (cur === null || i < span + 30) return null;
    let below = 0, n = 0;
    for (let j = Math.max(span, i - lookback); j <= i; j++) {
      if (v[j] === null) continue;
      n++;
      if (v[j] < cur) below++;
    }
    return below / n;
  });
}

/** Precompute indicators once so detectors stay cheap. */
export function buildContext(candles) {
  return {
    candles,
    sma20: sma(candles, 20),
    sma50: sma(candles, 50),
    ema8: ema(candles, 8),
    rsi14: rsi(candles, 14),
    volRank: volRank(candles),
  };
}

/** Earliest index at which every pattern/condition has enough history. */
export const MIN_HISTORY = 51;

// ── pattern library ──────────────────────────────────────────────────────────
// dir: "bull" = suggests up-move, "bear" = suggests down-move,
//      "context" = market state used as a filter in rules, not a signal.
// Each detect(ctx, i) may only read candles [0..i].
export const PATTERNS = {
  // — two-candle momentum —
  close_above_prev_high: {
    name: "Close above previous high", dir: "bull",
    detect: ({ candles: c }, i) => c[i].close > c[i - 1].high,
  },
  close_below_prev_low: {
    name: "Close below previous low", dir: "bear",
    detect: ({ candles: c }, i) => c[i].close < c[i - 1].low,
  },

  // — engulfing —
  bullish_engulfing: {
    name: "Bullish engulfing", dir: "bull",
    detect: ({ candles: c }, i) =>
      green(c[i]) && red(c[i - 1]) && c[i].close > c[i - 1].open && c[i].open < c[i - 1].close,
  },
  bearish_engulfing: {
    name: "Bearish engulfing", dir: "bear",
    detect: ({ candles: c }, i) =>
      red(c[i]) && green(c[i - 1]) && c[i].close < c[i - 1].open && c[i].open > c[i - 1].close,
  },

  // — single-candle shapes with prior-move context —
  hammer: {
    name: "Hammer after 3 down closes", dir: "bull",
    detect: ({ candles: c }, i) =>
      c[i - 1].close < c[i - 2].close && c[i - 2].close < c[i - 3].close &&
      lowerWick(c[i]) > 2 * body(c[i]) && upperWick(c[i]) < body(c[i]),
  },
  shooting_star: {
    name: "Shooting star after 3 up closes", dir: "bear",
    detect: ({ candles: c }, i) =>
      c[i - 1].close > c[i - 2].close && c[i - 2].close > c[i - 3].close &&
      upperWick(c[i]) > 2 * body(c[i]) && lowerWick(c[i]) < body(c[i]),
  },
  bull_marubozu: {
    name: "Bull marubozu (full body > 2%)", dir: "bull",
    detect: ({ candles: c }, i) =>
      green(c[i]) && body(c[i]) / range(c[i]) > 0.9 && body(c[i]) / c[i].open > 0.02,
  },
  bear_marubozu: {
    name: "Bear marubozu (full body > 2%)", dir: "bear",
    detect: ({ candles: c }, i) =>
      red(c[i]) && body(c[i]) / range(c[i]) > 0.9 && body(c[i]) / c[i].open > 0.02,
  },
  doji: {
    name: "Doji (body < 10% of range)", dir: "context",
    detect: ({ candles: c }, i) => body(c[i]) / range(c[i]) < 0.1,
  },

  // — inside / outside bars —
  inside_bar: {
    name: "Inside bar", dir: "bull",
    detect: ({ candles: c }, i) => c[i].high < c[i - 1].high && c[i].low > c[i - 1].low,
  },
  outside_bar_green: {
    name: "Outside bar closing green", dir: "bull",
    detect: ({ candles: c }, i) =>
      c[i].high > c[i - 1].high && c[i].low < c[i - 1].low && green(c[i]),
  },
  outside_bar_red: {
    name: "Outside bar closing red", dir: "bear",
    detect: ({ candles: c }, i) =>
      c[i].high > c[i - 1].high && c[i].low < c[i - 1].low && red(c[i]),
  },

  // — piercing / dark cloud —
  piercing_line: {
    name: "Piercing line", dir: "bull",
    detect: ({ candles: c }, i) =>
      red(c[i - 1]) && green(c[i]) && c[i].open < c[i - 1].close &&
      c[i].close > (c[i - 1].open + c[i - 1].close) / 2 && c[i].close < c[i - 1].open,
  },
  dark_cloud_cover: {
    name: "Dark cloud cover", dir: "bear",
    detect: ({ candles: c }, i) =>
      green(c[i - 1]) && red(c[i]) && c[i].open > c[i - 1].close &&
      c[i].close < (c[i - 1].open + c[i - 1].close) / 2 && c[i].close > c[i - 1].open,
  },

  // — three-candle formations —
  three_white_soldiers: {
    name: "Three white soldiers", dir: "bull",
    detect: ({ candles: c }, i) =>
      green(c[i - 2]) && green(c[i - 1]) && green(c[i]) &&
      c[i - 1].close > c[i - 2].close && c[i].close > c[i - 1].close &&
      body(c[i - 1]) / range(c[i - 1]) > 0.5 && body(c[i]) / range(c[i]) > 0.5,
  },
  three_black_crows: {
    name: "Three black crows", dir: "bear",
    detect: ({ candles: c }, i) =>
      red(c[i - 2]) && red(c[i - 1]) && red(c[i]) &&
      c[i - 1].close < c[i - 2].close && c[i].close < c[i - 1].close &&
      body(c[i - 1]) / range(c[i - 1]) > 0.5 && body(c[i]) / range(c[i]) > 0.5,
  },
  morning_star: {
    name: "Morning star", dir: "bull",
    detect: ({ candles: c }, i) =>
      red(c[i - 2]) && body(c[i - 2]) / range(c[i - 2]) > 0.5 &&
      body(c[i - 1]) / range(c[i - 1]) < 0.3 &&
      green(c[i]) && c[i].close > (c[i - 2].open + c[i - 2].close) / 2,
  },
  evening_star: {
    name: "Evening star", dir: "bear",
    detect: ({ candles: c }, i) =>
      green(c[i - 2]) && body(c[i - 2]) / range(c[i - 2]) > 0.5 &&
      body(c[i - 1]) / range(c[i - 1]) < 0.3 &&
      red(c[i]) && c[i].close < (c[i - 2].open + c[i - 2].close) / 2,
  },

  // — indicator-state conditions (filters for rules) —
  above_sma50: {
    name: "Close above SMA(50)", dir: "context",
    detect: (ctx, i) => ctx.sma50[i] !== null && ctx.candles[i].close > ctx.sma50[i],
  },
  below_sma50: {
    name: "Close below SMA(50)", dir: "context",
    detect: (ctx, i) => ctx.sma50[i] !== null && ctx.candles[i].close < ctx.sma50[i],
  },
  above_ema8: {
    name: "Close above EMA(8)", dir: "context",
    detect: (ctx, i) => ctx.ema8[i] !== null && ctx.candles[i].close > ctx.ema8[i],
  },
  rsi_oversold_bounce: {
    name: "RSI(14) was < 30, candle closes up", dir: "bull",
    detect: (ctx, i) => ctx.rsi14[i - 1] !== null && ctx.rsi14[i - 1] < 30 && green(ctx.candles[i]),
  },
  rsi_overbought_fade: {
    name: "RSI(14) was > 70, candle closes down", dir: "bear",
    detect: (ctx, i) => ctx.rsi14[i - 1] !== null && ctx.rsi14[i - 1] > 70 && red(ctx.candles[i]),
  },
  high_volatility: {
    name: "High volatility regime (top 30% of trailing year)", dir: "context",
    detect: (ctx, i) => ctx.volRank[i] !== null && ctx.volRank[i] >= 0.7,
  },
  low_volatility: {
    name: "Low volatility regime (bottom 30% of trailing year)", dir: "context",
    detect: (ctx, i) => ctx.volRank[i] !== null && ctx.volRank[i] <= 0.3,
  },
};

/** All pattern ids firing on candle i. Returns { bull:[], bear:[], context:[] }. */
export function detectAt(ctx, i) {
  const fired = { bull: [], bear: [], context: [] };
  if (i < MIN_HISTORY) return fired;
  for (const [id, p] of Object.entries(PATTERNS)) {
    if (p.detect(ctx, i)) fired[p.dir].push(id);
  }
  return fired;
}
