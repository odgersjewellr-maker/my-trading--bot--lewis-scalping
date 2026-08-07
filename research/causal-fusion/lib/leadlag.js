/**
 * Dynamic lead-lag fusion (statistical approximation).
 *
 * This is NOT a reproduction of the DeltaLag deep model from the research —
 * that's a learned neural model. This is the transparent, auditable version
 * of the same idea: instead of hardcoding "funding rate predicts direction",
 * re-estimate which feature stream currently correlates with next-bar
 * returns, on a trailing window, and reweight every bar. When a stream's
 * predictive relationship decays or flips sign, its weight decays or flips
 * with it — nothing here is a fixed rule.
 *
 * Every correlation used at bar i is computed only from pairs (feature[j],
 * ret[j+1]) with j < i, so nothing from bar i or later leaks into its own
 * weight estimate.
 */

const STREAMS = ["takerDelta", "fundingChange", "oiRoc"];
const WINDOW = 96; // trailing bars used to estimate current lead-lag correlation

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 10) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return 0;
  return num / Math.sqrt(dx2 * dy2);
}

function clip(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * bars: output of buildFeatureSeries. Returns one entry per bar with a
 * direction score in [-1, 1] forecasting the sign of ret[i+1], plus which
 * stream is currently doing the leading and how strong that lead is.
 */
export function computeLeadLagSeries(bars) {
  const out = new Array(bars.length).fill(null);

  // Bound is bars.length (not bars.length - 1): computing bar i's signal
  // only needs bars up to i itself (windowed pairs use j+1 <= i), so the
  // most recent bar always gets a real signal — important for live-preview.
  for (let i = WINDOW + 1; i < bars.length; i++) {
    const windowStart = i - WINDOW;
    const corrByStream = {};

    for (const stream of STREAMS) {
      const xs = [], ys = [];
      for (let j = windowStart; j < i; j++) {
        const x = bars[j][stream];
        const y = bars[j + 1].ret;
        if (x === null || Number.isNaN(x)) continue;
        xs.push(x);
        ys.push(y);
      }
      corrByStream[stream] = xs.length >= 10 ? pearson(xs, ys) : null;
    }

    const weights = {};
    let weightSum = 0;
    for (const stream of STREAMS) {
      const c = corrByStream[stream];
      if (c === null) continue;
      weights[stream] = Math.abs(c);
      weightSum += Math.abs(c);
    }

    if (weightSum === 0) {
      out[i] = { directionScore: 0, leadingStream: null, leadStrength: 0, corrByStream };
      continue;
    }

    // Standardize each current feature value against its own trailing window,
    // then combine using |corr|-proportional weights, sign from the corr itself.
    let directionScore = 0;
    for (const stream of STREAMS) {
      const c = corrByStream[stream];
      if (c === null) continue;
      const hist = [];
      for (let j = windowStart; j < i; j++) {
        const v = bars[j][stream];
        if (v !== null && !Number.isNaN(v)) hist.push(v);
      }
      const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
      const std = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length) || 1;
      const z = clip((bars[i][stream] - mean) / std, -3, 3) / 3; // -> [-1, 1]
      directionScore += (weights[stream] / weightSum) * Math.sign(c) * z;
    }
    directionScore = clip(directionScore, -1, 1);

    let leadingStream = null, leadStrength = 0;
    for (const stream of STREAMS) {
      const c = corrByStream[stream];
      if (c !== null && Math.abs(c) > leadStrength) {
        leadStrength = Math.abs(c);
        leadingStream = stream;
      }
    }

    out[i] = { directionScore, leadingStream, leadStrength, corrByStream };
  }

  return out;
}
