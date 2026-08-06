/**
 * Liquidation-cascade early-warning ensemble.
 *
 * Framing (per the 2026 "subcritical branching / first-order transition"
 * and "criticality is event-heterogeneous" research): cascades behave like
 * critical phase transitions, and no single precursor signal is reliable
 * across events. The honest response to "no single signal works" is an
 * ensemble vote, not picking one metric and hardcoding a threshold on it.
 *
 * Five causal metrics, each z-scored against its own trailing history:
 *   1. Realized-vol acceleration   (variance clustering)
 *   2. Return autocorrelation      (critical slowing down)
 *   3. Open-interest rate of change (leverage build-up)
 *   4. Funding-rate extremity       (positioning skew)
 *   5. Order-flow one-sidedness     (taker-buy/sell persistence)
 *
 * risk = fraction of the 5 that currently exceed a z-score threshold.
 * direction = which side is over-levered and vulnerable to a squeeze
 * (best-effort from funding + OI + flow sign; 0 when they disagree).
 */

const VOTE_THRESHOLD = 1.5;
const SHORT_VOL_WINDOW = 12;
const AUTOCORR_WINDOW = 24;
const BASELINE_WINDOW = 200;

function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
function std(a) { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); }

function zAgainstTrailing(series, i, baselineWindow) {
  const start = Math.max(0, i - baselineWindow);
  const hist = series.slice(start, i).filter((v) => v !== null && !Number.isNaN(v));
  if (hist.length < 20 || series[i] === null || Number.isNaN(series[i])) return null;
  const m = mean(hist), s = std(hist) || 1;
  return (series[i] - m) / s;
}

function rollingStd(rets, i, window) {
  const start = Math.max(0, i - window + 1);
  if (i - start < window - 1) return null;
  return std(rets.slice(start, i + 1));
}

function rollingAutocorr(rets, i, window) {
  const start = Math.max(0, i - window + 1);
  if (i - start < window - 1) return null;
  const slice = rets.slice(start, i + 1);
  const m = mean(slice);
  let num = 0, den = 0;
  for (let k = 0; k < slice.length; k++) {
    den += (slice[k] - m) ** 2;
    if (k > 0) num += (slice[k] - m) * (slice[k - 1] - m);
  }
  return den === 0 ? 0 : num / den;
}

export function computeCascadeSeries(bars) {
  const rets = bars.map((b) => b.ret);
  const shortVol = bars.map((_, i) => rollingStd(rets, i, SHORT_VOL_WINDOW));
  const autocorr = bars.map((_, i) => rollingAutocorr(rets, i, AUTOCORR_WINDOW));
  const flowPersistence = bars.map((_, i) => {
    const start = Math.max(0, i - SHORT_VOL_WINDOW + 1);
    const slice = bars.slice(start, i + 1).map((b) => b.takerDelta);
    return mean(slice);
  });

  const out = new Array(bars.length).fill(null);

  for (let i = BASELINE_WINDOW + AUTOCORR_WINDOW; i < bars.length; i++) {
    const zVol = zAgainstTrailing(shortVol, i, BASELINE_WINDOW);
    const zAutocorr = zAgainstTrailing(autocorr, i, BASELINE_WINDOW);
    const zOi = bars[i].oiRoc !== null ? zAgainstTrailing(bars.map((b) => b.oiRoc), i, BASELINE_WINDOW) : null;
    const zFunding = bars[i].fundingRate !== null
      ? zAgainstTrailing(bars.map((b) => (b.fundingRate === null ? null : Math.abs(b.fundingRate))), i, BASELINE_WINDOW)
      : null;
    const zFlow = zAgainstTrailing(flowPersistence.map((v) => Math.abs(v)), i, BASELINE_WINDOW);

    const votes = { vol: zVol, autocorr: zAutocorr, oi: zOi, funding: zFunding, flow: zFlow };
    const active = Object.values(votes).filter((v) => v !== null);
    const hits = active.filter((v) => Math.abs(v) > VOTE_THRESHOLD).length;
    const risk = active.length ? hits / active.length : 0;

    // Which side is over-levered: positive funding + rising OI + net-buy flow
    // => longs crowded => vulnerable to a downside (long-liquidation) cascade.
    // Mirror for the short side. Disagreement among the three => ambiguous (0).
    const fundingSign = bars[i].fundingRate === null ? 0 : Math.sign(bars[i].fundingRate);
    const flowSign = Math.sign(flowPersistence[i]);
    const oiRising = bars[i].oiRoc !== null && bars[i].oiRoc > 0;
    let direction = 0;
    if (oiRising && fundingSign > 0 && flowSign > 0) direction = -1; // longs crowded
    else if (oiRising && fundingSign < 0 && flowSign < 0) direction = 1; // shorts crowded

    out[i] = { risk, direction, votes, hits, activeCount: active.length };
  }

  return out;
}
