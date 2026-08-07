import { fetchStablecoinMintEvents } from "../../../stablecoin-flow/lib/etherscanData.js";
import { fetchDailyCloses } from "../../../stablecoin-flow/lib/priceData.js";
import { buildMintFeatureSeries } from "../../../stablecoin-flow/lib/mintFeatures.js";
import { computeFlowSignalSeries } from "../../../stablecoin-flow/lib/flowSignal.js";

const DAYS = 240;

export async function getStablecoinFlowSignal(symbol) {
  try {
    const [priceBars, mintEvents] = await Promise.all([
      fetchDailyCloses(symbol, DAYS),
      fetchStablecoinMintEvents(),
    ]);
    const bars = buildMintFeatureSeries(priceBars, mintEvents);
    const signals = computeFlowSignalSeries(bars);
    const last = signals[signals.length - 1];
    if (!last) return { name: "stablecoin-flow", available: false, error: "not enough history yet (needs 180+ days)" };

    return {
      name: "stablecoin-flow",
      available: true,
      direction: last.direction,
      conviction: last.conviction,
      detail: last.rationale.join(" | "),
    };
  } catch (err) {
    return { name: "stablecoin-flow", available: false, error: err.message };
  }
}
