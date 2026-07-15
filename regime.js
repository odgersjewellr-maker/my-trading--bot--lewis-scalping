/**
 * Market-regime detection & Turtle Soup adaptation.
 *
 * Turtle Soup is a mean-reversion fade. Whether a fade is smart depends entirely
 * on the regime:
 *   - a LONG fade (buy a false breakdown) is "buy the dip" — great in a BULL.
 *   - a SHORT fade (sell a false breakout) is "sell the rip" — great in a BEAR,
 *     suicidal in a bull.
 *   - in a FLAT/range, both fades pay and pay fast — so size up and get out
 *     quick (small time in market).
 *
 * So we detect the regime from a trend SMA (its level relative to price and its
 * slope) and map it to: which sides to take, a size multiplier, and a hold-time
 * multiplier. All causal (no lookahead) and tunable via env.
 */

export const REGIME_DEFAULTS = {
  on:            false, // off by default so plain Turtle Soup is unchanged
  trendLen:      50,    // SMA length that defines the trend
  slopeLen:      10,    // bars back to measure SMA slope
  bandPct:       0.5,   // % band around the SMA that still counts as "flat"
  // Behaviour per regime — bull favours longs, bear favours shorts, flat trades
  // both bigger and faster.
  bullLong:      true,  bullShort:  false,
  bearLong:      false, bearShort:  true,
  flatLong:      true,  flatShort:  true,
  flatSizeMult:  1.5,   flatHoldMult:  0.5,  // range: larger size, small time in market
  trendSizeMult: 1.0,   trendHoldMult: 1.0,  // with-trend fade: normal
};

export function regimeParamsFromEnv(env = process.env) {
  const b = (k, d) => (env[k] === undefined ? d : env[k] !== "false");
  const f = (k, d) => (env[k] === undefined ? d : parseFloat(env[k]));
  const i = (k, d) => (env[k] === undefined ? d : parseInt(env[k]));
  return {
    on:            env.REGIME_ON === "true" ? true : (env.REGIME_ON === "false" ? false : REGIME_DEFAULTS.on),
    trendLen:      i("REGIME_TREND_LEN", REGIME_DEFAULTS.trendLen),
    slopeLen:      i("REGIME_SLOPE_LEN", REGIME_DEFAULTS.slopeLen),
    bandPct:       f("REGIME_BAND_PCT",  REGIME_DEFAULTS.bandPct),
    bullLong:  b("REGIME_BULL_LONG",  REGIME_DEFAULTS.bullLong),
    bullShort: b("REGIME_BULL_SHORT", REGIME_DEFAULTS.bullShort),
    bearLong:  b("REGIME_BEAR_LONG",  REGIME_DEFAULTS.bearLong),
    bearShort: b("REGIME_BEAR_SHORT", REGIME_DEFAULTS.bearShort),
    flatLong:  b("REGIME_FLAT_LONG",  REGIME_DEFAULTS.flatLong),
    flatShort: b("REGIME_FLAT_SHORT", REGIME_DEFAULTS.flatShort),
    flatSizeMult:  f("REGIME_FLAT_SIZE_MULT",  REGIME_DEFAULTS.flatSizeMult),
    flatHoldMult:  f("REGIME_FLAT_HOLD_MULT",  REGIME_DEFAULTS.flatHoldMult),
    trendSizeMult: f("REGIME_TREND_SIZE_MULT", REGIME_DEFAULTS.trendSizeMult),
    trendHoldMult: f("REGIME_TREND_HOLD_MULT", REGIME_DEFAULTS.trendHoldMult),
  };
}

// Causal simple-moving-average series (null until enough bars).
export function smaSeries(values, len) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

/**
 * Classify every bar as "bull" | "bear" | "flat" using only past/current data.
 * @returns { regime[], sma[], trendPct[] }
 */
export function detectRegimeSeries(candles, params = {}) {
  const p = { ...REGIME_DEFAULTS, ...params };
  const closes = candles.map((c) => c.close);
  const sma = smaSeries(closes, p.trendLen);
  const regime = new Array(candles.length).fill("flat");
  const trendPct = new Array(candles.length).fill(0);
  for (let i = 0; i < candles.length; i++) {
    const s = sma[i];
    if (s == null) { regime[i] = "flat"; continue; }
    const price = closes[i];
    trendPct[i] = (price / s - 1) * 100;
    const prev = sma[i - p.slopeLen];
    const slope = prev == null ? 0 : s - prev;
    const band = s * (p.bandPct / 100);
    if (price >= s + band && slope > 0) regime[i] = "bull";
    else if (price <= s - band && slope < 0) regime[i] = "bear";
    else regime[i] = "flat";
  }
  return { regime, sma, trendPct };
}

/** Map a regime label to Turtle Soup behaviour. */
export function adaptationFor(regime, params = {}) {
  const p = { ...REGIME_DEFAULTS, ...params };
  if (regime === "bull") return { allowLong: p.bullLong, allowShort: p.bullShort, sizeMult: p.trendSizeMult, holdMult: p.trendHoldMult };
  if (regime === "bear") return { allowLong: p.bearLong, allowShort: p.bearShort, sizeMult: p.trendSizeMult, holdMult: p.trendHoldMult };
  return { allowLong: p.flatLong, allowShort: p.flatShort, sizeMult: p.flatSizeMult, holdMult: p.flatHoldMult };
}
