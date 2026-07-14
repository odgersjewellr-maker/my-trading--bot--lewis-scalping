/**
 * Turtle Soup — false-breakout reversal strategy.
 *
 * Popularised by Linda Raschke & Larry Connors in "Street Smarts". The idea:
 * markets frequently poke *just* beyond a recent N-bar high/low to trip breakout
 * traders' stops, then snap back. Turtle Soup fades that failed breakout.
 *
 *   LONG  — price undercuts the prior N-bar LOW (a false breakdown) and then
 *           closes back ABOVE that old low. You buy the reversal, stop under the
 *           breakout extreme.
 *   SHORT — mirror image: price spikes above the prior N-bar HIGH and closes
 *           back BELOW it.
 *
 * Raschke's original enters intrabar with a resting order at the prior extreme.
 * A bar-close cron bot can't rest intrabar orders reliably, so this module uses
 * the standard bar-close adaptation: the reversal is confirmed only once the bar
 * that broke the level *closes back through it*. Entry is that close.
 *
 * A second Raschke filter is kept: the prior extreme must be at least
 * `minPriorAgeBars` bars old, so we're fading a break of a genuine, established
 * level rather than yesterday's noise.
 *
 * This file is pure (no I/O, no side effects) so it can be unit-tested,
 * backtested (backtest-turtle-soup.js) and driven live (bot.js) from the same
 * code path.
 */

export const TS_DEFAULTS = {
  lookback:        20,   // N-bar high/low the breakout is measured against
  minPriorAgeBars: 3,    // prior extreme must be at least this many bars old
  buffer:          0.0,  // extra fraction beyond the breakout extreme for the stop (e.g. 0.001 = 0.1%)
  rewardRisk:      2.0,  // take-profit distance as a multiple of the stop distance
  maxHoldBars:     4,    // time-stop: exit if neither stop nor target hits within this many bars
  allowLong:       true,
  allowShort:      true,
};

/**
 * Evaluate the Turtle Soup setup on the LAST candle of `candles`.
 *
 * @param candles oldest-first array of {open,high,low,close,...}. The final
 *   element is the just-closed bar being evaluated.
 * @returns { signal: "BUY"|"SELL"|null, ... } — on a signal also includes
 *   side, priorExtreme, priorAgeBars, stop, and a human-readable note.
 */
export function turtleSoupSignal(candles, params = {}) {
  const p = { ...TS_DEFAULTS, ...params };
  const n = candles.length;
  const need = p.lookback + 2;
  if (n < need) return { signal: null, reason: `need ${need} bars, have ${n}` };

  const i = n - 1;                 // bar under evaluation (just closed)
  const today = candles[i];

  // Prior window = the `lookback` bars immediately before today: [i-lookback, i-1].
  const winStart = i - p.lookback;
  let priorLow = Infinity, priorLowIdx = -1;
  let priorHigh = -Infinity, priorHighIdx = -1;
  for (let k = winStart; k <= i - 1; k++) {
    if (candles[k].low  < priorLow)  { priorLow  = candles[k].low;  priorLowIdx  = k; }
    if (candles[k].high > priorHigh) { priorHigh = candles[k].high; priorHighIdx = k; }
  }
  const lowAge  = i - priorLowIdx;   // bars since the prior low  was set
  const highAge = i - priorHighIdx;  // bars since the prior high was set

  // LONG — false breakdown: today dipped below the prior low but closed back above it.
  if (p.allowLong &&
      today.low   <  priorLow &&
      today.close >  priorLow &&
      lowAge >= p.minPriorAgeBars) {
    const stop = Math.min(today.low, priorLow) * (1 - p.buffer);
    return {
      signal: "BUY",
      side: "long",
      priorExtreme: priorLow,
      priorAgeBars: lowAge,
      breakoutExtreme: today.low,
      stop,
      note: `false breakdown of ${p.lookback}-bar low $${priorLow} (${lowAge} bars old), reclaimed on close`,
    };
  }

  // SHORT — false breakout: today poked above the prior high but closed back below it.
  if (p.allowShort &&
      today.high  >  priorHigh &&
      today.close <  priorHigh &&
      highAge >= p.minPriorAgeBars) {
    const stop = Math.max(today.high, priorHigh) * (1 + p.buffer);
    return {
      signal: "SELL",
      side: "short",
      priorExtreme: priorHigh,
      priorAgeBars: highAge,
      breakoutExtreme: today.high,
      stop,
      note: `false breakout of ${p.lookback}-bar high $${priorHigh} (${highAge} bars old), rejected on close`,
    };
  }

  return {
    signal: null,
    priorLow, priorHigh, lowAge, highAge,
    reason: "no false-breakout reversal on the last close",
  };
}

/**
 * Turn a signal + the entry price into a full trade plan: stop, target, risk.
 * Target sits `rewardRisk` × (entry−stop) away in the trade's direction.
 */
export function turtleSoupPlan(sig, entryPrice, params = {}) {
  const p = { ...TS_DEFAULTS, ...params };
  if (!sig || !sig.signal) return null;
  const risk = Math.abs(entryPrice - sig.stop);
  const target = sig.side === "long"
    ? entryPrice + risk * p.rewardRisk
    : entryPrice - risk * p.rewardRisk;
  return {
    side: sig.side,
    entry: entryPrice,
    stop: sig.stop,
    target,
    risk,
    rewardRisk: p.rewardRisk,
    maxHoldBars: p.maxHoldBars,
  };
}

/** Build a params object from process.env (shared by bot.js and the backtest). */
export function tsParamsFromEnv(env = process.env) {
  return {
    lookback:        parseInt(env.TS_LOOKBACK        || TS_DEFAULTS.lookback),
    minPriorAgeBars: parseInt(env.TS_MIN_AGE_BARS    || TS_DEFAULTS.minPriorAgeBars),
    buffer:          parseFloat(env.TS_STOP_BUFFER   || TS_DEFAULTS.buffer),
    rewardRisk:      parseFloat(env.TS_REWARD_RISK   || TS_DEFAULTS.rewardRisk),
    maxHoldBars:     parseInt(env.TS_MAX_HOLD_BARS   || TS_DEFAULTS.maxHoldBars),
    allowLong:       env.TS_ALLOW_LONG  !== "false",
    allowShort:      env.TS_ALLOW_SHORT !== "false",
  };
}
