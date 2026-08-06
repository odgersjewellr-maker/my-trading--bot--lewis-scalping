/**
 * Combines the lead-lag direction score with the cascade risk ensemble
 * into one conviction-weighted signal.
 *
 * Key design choice: when cascade risk and lead-lag direction AGREE (a
 * squeeze would push price the same way the lead-lag fusion already
 * expects), conviction is boosted. When they DISAGREE, conviction is
 * DAMPENED rather than one layer overriding the other — this is the
 * direct response to the "regime boundary" failure mode from the
 * research (signals that look valid inside a regime break exactly at
 * transitions). Disagreement is treated as "we're near a boundary, size
 * down", not resolved by picking a winner.
 */

const MIN_LEAD_STRENGTH = 0.05; // below this, there's no real signal to act on

function clip(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function combineSignal(leadLag, cascade) {
  if (!leadLag || !cascade || leadLag.leadStrength < MIN_LEAD_STRENGTH) {
    return {
      direction: "flat",
      conviction: 0,
      directionScore: leadLag ? leadLag.directionScore : 0,
      leadingStream: leadLag ? leadLag.leadingStream : null,
      leadStrength: leadLag ? leadLag.leadStrength : 0,
      cascadeRisk: cascade ? cascade.risk : 0,
      cascadeDirection: cascade ? cascade.direction : 0,
      rationale: ["lead-lag strength below minimum threshold — no actionable edge this bar"],
    };
  }

  const { directionScore, leadingStream, leadStrength } = leadLag;
  const direction = directionScore > 0 ? "long" : directionScore < 0 ? "short" : "flat";
  const sig = Math.sign(directionScore);

  const agrees = cascade.direction !== 0 && cascade.direction === sig;
  const disagrees = cascade.direction !== 0 && cascade.direction === -sig;

  let cascadeAdj = 1;
  const rationale = [
    `lead-lag: ${leadingStream ?? "n/a"} leading (|r|=${leadStrength.toFixed(2)}), score=${directionScore.toFixed(2)} -> ${direction}`,
  ];

  if (agrees) {
    cascadeAdj = 1 + cascade.risk * 0.5;
    rationale.push(`cascade: risk=${cascade.risk.toFixed(2)}, crowd on the vulnerable side agrees with signal -> conviction boosted`);
  } else if (disagrees) {
    cascadeAdj = 1 - cascade.risk * 0.7;
    rationale.push(`cascade: risk=${cascade.risk.toFixed(2)}, opposes signal (possible boundary) -> conviction dampened`);
  } else {
    rationale.push(`cascade: risk=${cascade.risk.toFixed(2)}, no clear crowded side -> no adjustment`);
  }

  const conviction = clip(Math.abs(directionScore) * cascadeAdj, 0, 1);

  return {
    direction: conviction === 0 ? "flat" : direction,
    conviction,
    directionScore,
    leadingStream,
    leadStrength,
    cascadeRisk: cascade.risk,
    cascadeDirection: cascade.direction,
    rationale,
  };
}

export function buildSignalSeries(bars, leadLagSeries, cascadeSeries) {
  return bars.map((b, i) => ({
    time: b.time,
    close: b.close,
    ...combineSignal(leadLagSeries[i], cascadeSeries[i]),
  }));
}
