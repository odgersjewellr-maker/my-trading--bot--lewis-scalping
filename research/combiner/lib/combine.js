/**
 * Confidence-weighted opinion pool — NOT a rigorous covariance/Markowitz
 * portfolio optimization. That would need historical return series for
 * every signal, and two of these four don't have one: exchange-netflow
 * is brand new, and llm-forecast has no backtest at all by design (see
 * its README on why). This is a defensible, transparent starting point
 * instead: each signal gets a base weight reflecting how much
 * backtestable evidence currently exists behind it.
 *
 * llm-forecast's weight is the interesting one — it's not a fixed tier,
 * it's literally zero until its own scorecard shows better-than-coinflip
 * accuracy on 30+ resolved predictions. That's the honest version of
 * "self-learning" applied to portfolio construction: the LLM signal has
 * to earn a vote with real logged evidence, not get one by default.
 *
 * Upgrade path once there's enough live history from all four modules:
 * replace these static tiers with weights derived from each module's
 * actual realized Sharpe / correlation with the others.
 */

const BASE_WEIGHTS = {
  "causal-fusion": 1.0, // hourly data, thousands of observations per window, real backtest infra
  "stablecoin-flow": 0.5, // sparse events — see its own README
  "exchange-netflow": 0.4, // sparse events AND single-wallet — weakest evidence base of the three statistical signals
};

const LLM_MIN_RESOLVED = 30;

function llmWeight(signal) {
  if (signal.resolvedCount < LLM_MIN_RESOLVED || signal.accuracy === null) return 0; // unproven — no vote yet
  // 50% accuracy -> 0 weight, 75%+ -> full weight, linear between, clipped both ends.
  return Math.max(0, Math.min(1, (signal.accuracy - 0.5) * 4));
}

export function combineSignals(signals) {
  const contributions = [];
  let weightedSum = 0;
  let weightTotal = 0;

  for (const s of signals) {
    if (!s.available) {
      contributions.push({ name: s.name, weight: 0, contribution: 0, note: `unavailable — ${s.error}` });
      continue;
    }

    const sign = s.direction === "long" ? 1 : s.direction === "short" ? -1 : 0;
    if (sign === 0) {
      contributions.push({ name: s.name, weight: 0, contribution: 0, note: "flat — no directional vote" });
      continue;
    }

    const baseWeight = s.name === "llm-forecast" ? llmWeight(s) : (BASE_WEIGHTS[s.name] ?? 0);
    if (baseWeight === 0) {
      const note = s.name === "llm-forecast"
        ? `excluded — unproven (needs 30+ resolved predictions with >50% accuracy; currently ${s.resolvedCount ?? 0} resolved${s.accuracy !== null && s.accuracy !== undefined ? `, ${(s.accuracy * 100).toFixed(0)}% accuracy` : ""})`
        : "excluded — zero base weight";
      contributions.push({ name: s.name, weight: 0, contribution: 0, note });
      continue;
    }

    const contribution = baseWeight * s.conviction * sign;
    weightedSum += contribution;
    weightTotal += baseWeight;
    contributions.push({ name: s.name, weight: baseWeight, contribution, direction: s.direction, conviction: s.conviction });
  }

  const portfolioScore = weightTotal > 0 ? weightedSum / weightTotal : 0;
  const direction = portfolioScore > 0 ? "long" : portfolioScore < 0 ? "short" : "flat";
  const conviction = Math.min(1, Math.abs(portfolioScore));

  return { direction, conviction, portfolioScore, contributions };
}
