/**
 * Same dynamic lead-lag method as stablecoin-flow and causal-fusion:
 * re-estimate, on a trailing window, which flow feature (raw daily flow
 * vs 3/7/14-day cumulative) currently correlates with next-day BTC
 * returns, and weight accordingly.
 *
 * SAME sparse-event caveat as stablecoin-flow applies here, made worse by
 * this module watching only one wallet: with a single address, most days
 * have near-zero flow and the handful of days with real signal are rarer
 * than stablecoin-flow's already-sparse mint events. Treat any correlation
 * this finds with real skepticism — this is closer to a proof of concept
 * than a mature signal until more wallets are added responsibly.
 */

const STREAMS = ["dailyNetFlow", "cum3", "cum7", "cum14"];
const WINDOW = 180;
const MIN_LEAD_STRENGTH = 0.08;

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 20) return null;
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

export function computeFlowSignalSeries(bars) {
  const out = new Array(bars.length).fill(null);

  for (let i = WINDOW + 1; i < bars.length; i++) {
    const start = i - WINDOW;
    const corrByStream = {};

    for (const stream of STREAMS) {
      const xs = [], ys = [];
      for (let j = start; j < i; j++) {
        xs.push(bars[j][stream]);
        ys.push(bars[j + 1].ret);
      }
      corrByStream[stream] = pearson(xs, ys);
    }

    const weights = {};
    let weightSum = 0;
    for (const stream of STREAMS) {
      const c = corrByStream[stream];
      if (c === null) continue;
      weights[stream] = Math.abs(c);
      weightSum += Math.abs(c);
    }

    let leadingStream = null, leadStrength = 0;
    for (const stream of STREAMS) {
      const c = corrByStream[stream];
      if (c !== null && Math.abs(c) > leadStrength) {
        leadStrength = Math.abs(c);
        leadingStream = stream;
      }
    }

    if (weightSum === 0 || leadStrength < MIN_LEAD_STRENGTH) {
      out[i] = {
        direction: "flat", conviction: 0, directionScore: 0,
        leadingStream, leadStrength, corrByStream,
        rationale: [`lead strength ${leadStrength.toFixed(2)} below minimum ${MIN_LEAD_STRENGTH} — no actionable edge`],
      };
      continue;
    }

    let directionScore = 0;
    for (const stream of STREAMS) {
      const c = corrByStream[stream];
      if (c === null) continue;
      const hist = [];
      for (let j = start; j < i; j++) hist.push(bars[j][stream]);
      const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
      const std = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length) || 1;
      const z = clip((bars[i][stream] - mean) / std, -3, 3) / 3;
      directionScore += (weights[stream] / weightSum) * Math.sign(c) * z;
    }
    directionScore = clip(directionScore, -1, 1);

    const direction = directionScore > 0 ? "long" : directionScore < 0 ? "short" : "flat";
    const conviction = clip(Math.abs(directionScore), 0, 1);

    out[i] = {
      direction: conviction === 0 ? "flat" : direction,
      conviction,
      directionScore,
      leadingStream,
      leadStrength,
      corrByStream,
      rationale: [
        `${leadingStream} leading (|r|=${leadStrength.toFixed(2)} over trailing ${WINDOW}d), score=${directionScore.toFixed(2)} -> ${direction}`,
      ],
    };
  }

  return out;
}
