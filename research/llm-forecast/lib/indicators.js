/** Standard indicator math, kept dependency-free and consistent with rules.json's definitions. */

export function ema(closes, period) {
  const k = 2 / (period + 1);
  let prev = closes[0];
  const out = [prev];
  for (let i = 1; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gainSum += change; else lossSum -= change;
  }
  let avgGain = gainSum / period, avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(change, 0), loss = Math.max(-change, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Rolling VWAP over the whole supplied window — NOT a midnight-reset
 * session VWAP like the live bot's rules.json uses. This is a simpler
 * "trailing N bars" approximation, good enough for giving the model
 * directional context, not meant to match the live strategy exactly.
 */
export function rollingVwap(bars) {
  let pv = 0, v = 0;
  for (const b of bars) {
    pv += b.close * b.volume;
    v += b.volume;
  }
  return v === 0 ? bars[bars.length - 1].close : pv / v;
}

/** Order-flow proxy: +1 = all buy-side taker volume, -1 = all sell-side. */
export function takerDelta(bar) {
  return bar.volume > 0 ? 2 * (bar.takerBuyBaseVolume / bar.volume) - 1 : 0;
}
