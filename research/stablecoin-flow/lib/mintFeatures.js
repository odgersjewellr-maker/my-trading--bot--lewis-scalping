/**
 * Aligns mint/burn events onto the daily price timeline and derives
 * rolling net-flow features. Everything here uses only events with
 * timestamp < the bar's END time — a bar never sees flow that happens
 * later the same day in a way that could leak into same-day prediction
 * (the signal module additionally only ever acts on bar i to predict
 * bar i+1, so same-day inclusion here is fine, not a lookahead risk).
 */

export function buildMintFeatureSeries(priceBars, mintEvents) {
  const dailyNetFlow = new Array(priceBars.length).fill(0);

  for (let i = 0; i < priceBars.length; i++) {
    const start = priceBars[i].time;
    const end = i + 1 < priceBars.length ? priceBars[i + 1].time : start + 86400000;
    for (const ev of mintEvents) {
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
