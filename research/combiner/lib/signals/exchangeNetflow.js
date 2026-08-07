import { fetchWatchedWalletFlows } from "../../../exchange-netflow/lib/exchangeNetflowData.js";
import { fetchDailyCloses } from "../../../exchange-netflow/lib/priceData.js";
import { buildNetflowFeatureSeries } from "../../../exchange-netflow/lib/netflowFeatures.js";
import { computeFlowSignalSeries } from "../../../exchange-netflow/lib/flowSignal.js";

const DAYS = 240;

export async function getExchangeNetflowSignal(symbol) {
  if (symbol !== "BTCUSDT") {
    return { name: "exchange-netflow", available: false, error: "BTC-only data source (watched wallet is a Bitcoin address)" };
  }
  try {
    const [priceBars, flowEvents] = await Promise.all([
      fetchDailyCloses(symbol, DAYS),
      fetchWatchedWalletFlows(DAYS),
    ]);
    const bars = buildNetflowFeatureSeries(priceBars, flowEvents);
    const signals = computeFlowSignalSeries(bars);
    const last = signals[signals.length - 1];
    if (!last) return { name: "exchange-netflow", available: false, error: "not enough history yet (needs 180+ days)" };

    return {
      name: "exchange-netflow",
      available: true,
      direction: last.direction,
      conviction: last.conviction,
      detail: last.rationale.join(" | "),
    };
  } catch (err) {
    return { name: "exchange-netflow", available: false, error: err.message };
  }
}
