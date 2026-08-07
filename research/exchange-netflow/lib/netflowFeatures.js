/**
 * Aligns wallet flow events onto the daily price timeline. Sign
 * convention: positive dailyNetFlow = the watched wallet(s) received more
 * BTC than they sent that day (net inflow to exchange custody).
 * Conventional wisdom reads that as bearish (deposits ahead of selling)
 * and outflow as bullish — but this module doesn't hardcode that. Like
 * the other flow modules, flowSignal.js discovers the actual empirical
 * relationship on a trailing window rather than assuming it.
 */

export function buildNetflowFeatureSeries(priceBars, flowEvents) {
  const dailyNetFlow = new Array(priceBars.length).fill(0);

  for (let i = 0; i < priceBars.length; i++) {
    const start = priceBars[i].time;
    const end = i + 1 < priceBars.length ? priceBars[i + 1].time : start + 86400000;
    for (const ev of flowEvents) {
      if (ev.time >= start && ev.time < end) dailyNetFlow[i] += ev.amount;
    }
  }

  const cumSum = (window) =>
    dailyNetFlow.map((_, i) => {
      const start = Math.max(0, i - window + 1);
      let s = 0;
      for (let j = start; j <= i; j++) s += dailyNetFlow[j];
      return s;
    });

  const cum3 = cumSum(3);
  const cum7 = cumSum(7);
  const cum14 = cumSum(14);

  return priceBars.map((b, i) => ({
    time: b.time,
    close: b.close,
    ret: i > 0 ? Math.log(b.close / priceBars[i - 1].close) : 0,
    dailyNetFlow: dailyNetFlow[i],
    cum3: cum3[i],
    cum7: cum7[i],
    cum14: cum14[i],
  }));
}
