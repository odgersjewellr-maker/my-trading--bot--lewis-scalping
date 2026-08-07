import { fetchFuturesKlines, fetchFundingHistory, fetchOpenInterestHistory } from "../../../causal-fusion/lib/binanceData.js";
import { buildFeatureSeries } from "../../../causal-fusion/lib/features.js";
import { computeLeadLagSeries } from "../../../causal-fusion/lib/leadlag.js";
import { computeCascadeSeries } from "../../../causal-fusion/lib/cascade.js";
import { combineSignal } from "../../../causal-fusion/lib/signal.js";

const DAYS = 20;
const INTERVAL = "1h";

export async function getCausalFusionSignal(symbol) {
  try {
    const [klines, funding, openInterest] = await Promise.all([
      fetchFuturesKlines(symbol, INTERVAL, DAYS),
      fetchFundingHistory(symbol, DAYS),
      fetchOpenInterestHistory(symbol, "1h"),
    ]);
    const bars = buildFeatureSeries({ klines, funding, openInterest });
    const leadLagSeries = computeLeadLagSeries(bars);
    const cascadeSeries = computeCascadeSeries(bars);
    const last = bars.length - 1;
    const signal = combineSignal(leadLagSeries[last], cascadeSeries[last]);

    return {
      name: "causal-fusion",
      available: true,
      direction: signal.direction,
      conviction: signal.conviction,
      detail: signal.rationale.join(" | "),
    };
  } catch (err) {
    return { name: "causal-fusion", available: false, error: err.message };
  }
}
