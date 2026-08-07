import { ema, rsi, rollingVwap, takerDelta } from "./indicators.js";

/**
 * Builds the structured snapshot text handed to the model. Pure function
 * (no network) so it's testable in isolation from the API calls.
 */
export function buildSnapshot({ symbol, klines, orderBook, funding, openInterest, horizonHours, playbook = null }) {
  const closes = klines.map((k) => k.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const rsi3 = rsi(closes, 3);
  const rsi14 = rsi(closes, 14);
  const vwap24 = rollingVwap(klines.slice(-24));
  const last = klines[klines.length - 1];

  const recentRows = klines.slice(-30).map((k) =>
    [
      new Date(k.openTime).toISOString().slice(0, 16).replace("T", " "),
      k.close.toFixed(2),
      k.volume.toFixed(1),
      takerDelta(k).toFixed(2),
    ].join(",")
  );

  const flowPersistence = klines.slice(-12).reduce((s, k) => s + takerDelta(k), 0) / 12;

  const playbookSection = playbook
    ? `=== Accumulated self-critique from your own past predictions ===
${playbook}
Read the above, but weigh it against the live data below — it's your own
best guess at your own patterns from a limited sample, not ground truth.
=== End self-critique ===

`
    : "";

  return {
    text: `${playbookSection}Symbol: ${symbol}
As of: ${new Date(last.openTime).toISOString()}
Forecast horizon: next ${horizonHours}h

Last 30 hourly bars (time, close, volume, taker-buy-delta [-1 sell-dominant, +1 buy-dominant]):
${recentRows.join("\n")}

Indicators (current):
- EMA(8): ${ema8[ema8.length - 1].toFixed(2)}
- EMA(21): ${ema21[ema21.length - 1].toFixed(2)}
- RSI(3): ${rsi3[rsi3.length - 1]?.toFixed(1) ?? "n/a"}
- RSI(14): ${rsi14[rsi14.length - 1]?.toFixed(1) ?? "n/a"}
- Rolling 24h VWAP: ${vwap24.toFixed(2)}
- Current close: ${last.close.toFixed(2)}
- 12h avg taker-buy-delta (order-flow persistence): ${flowPersistence.toFixed(2)}

Liquidity (live order book, top 20 levels):
- Best bid: ${orderBook.bestBid} / Best ask: ${orderBook.bestAsk}
- Spread: ${orderBook.spreadPct?.toFixed(3)}%
- Book imbalance: ${orderBook.imbalance.toFixed(2)} (+1 = all bids, -1 = all asks)

Positioning:
- Funding rate (latest): ${(funding.rate * 100).toFixed(4)}%
- Open interest: ${openInterest.toLocaleString()}

This is a genuine forward test — the outcome does not exist yet. Predict the direction
of ${symbol} over the next ${horizonHours}h using the data above. Give a calibrated confidence:
it will be scored against realized outcomes across many predictions, so don't inflate it,
and don't default to "flat" as a hedge — only use it if you truly see no edge.`,
    indicators: {
      ema8: ema8[ema8.length - 1],
      ema21: ema21[ema21.length - 1],
      rsi3: rsi3[rsi3.length - 1],
      rsi14: rsi14[rsi14.length - 1],
      vwap24,
      flowPersistence,
      close: last.close,
    },
  };
}
