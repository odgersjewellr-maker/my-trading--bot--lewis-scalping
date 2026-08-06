/**
 * Aligns raw Binance streams (klines, funding, OI) onto one bar timeline
 * and derives the feature series the rest of the pipeline consumes.
 *
 * Alignment rule: every series is forward-filled using only values whose
 * timestamp is <= the bar's openTime. This is what keeps the backtest
 * honest — funding/OI updates that happened after a bar can never leak
 * into that bar's features.
 */

function mostRecentAtOrBefore(sortedByTime, t, getTime) {
  // Binary search for the last entry with time <= t.
  let lo = 0, hi = sortedByTime.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (getTime(sortedByTime[mid]) <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans === -1 ? null : sortedByTime[ans];
}

export function buildFeatureSeries({ klines, funding, openInterest }) {
  const bars = [];

  for (let i = 1; i < klines.length; i++) {
    const k = klines[i];
    const prev = klines[i - 1];
    const t = k.openTime;

    const ret = Math.log(k.close / prev.close);
    const takerDelta = k.volume > 0 ? 2 * (k.takerBuyBaseVolume / k.volume) - 1 : 0;

    const f = mostRecentAtOrBefore(funding, t, (x) => x.time);
    const fPrev = f ? mostRecentAtOrBefore(funding, f.time - 1, (x) => x.time) : null;
    const fundingRate = f ? f.rate : null;
    const fundingChange = f && fPrev ? f.rate - fPrev.rate : 0;

    const oi = mostRecentAtOrBefore(openInterest, t, (x) => x.time);
    let oiRoc = null;
    if (oi) {
      const oiPrev = mostRecentAtOrBefore(openInterest, oi.time - 1, (x) => x.time);
      if (oiPrev && oiPrev.sumOpenInterest > 0) {
        oiRoc = (oi.sumOpenInterest - oiPrev.sumOpenInterest) / oiPrev.sumOpenInterest;
      }
    }

    bars.push({
      time: t,
      close: k.close,
      ret,
      takerDelta,
      fundingRate,
      fundingChange,
      openInterest: oi ? oi.sumOpenInterest : null,
      oiRoc,
    });
  }

  return bars;
}

/** Rolling z-score, causal (window ends at i-1, never includes the current bar). */
export function rollingZ(values, i, window) {
  const start = Math.max(0, i - window);
  const slice = values.slice(start, i).filter((v) => v !== null && !Number.isNaN(v));
  if (slice.length < Math.min(10, window / 2)) return null;
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (values[i] - mean) / std;
}
