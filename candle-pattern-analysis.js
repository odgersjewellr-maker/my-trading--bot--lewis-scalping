// candle-pattern-analysis.js
// Tests the "close fully above previous candle" pattern on historical candles.
//
// Pattern: today's close > yesterday's HIGH (candle closes fully above the previous one).
// Question: does that make the NEXT candle more likely to be bullish (green)?
//
// Usage: node candle-pattern-analysis.js [csv-file]
// CSV format: Date,Open,High,Low,Close,Volume (same as btc-daily-binance.csv)

import fs from 'fs';

const file = process.argv[2] || 'btc-daily-binance.csv';
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map(l => {
  const [date, open, high, low, close, volume] = l.split(',');
  return { date, open: +open, high: +high, low: +low, close: +close, volume: +volume };
});

const isGreen = c => c.close > c.open;
const pct = (a, b) => ((a / b) * 100).toFixed(1);

// ---- Baseline: how often is any candle green? ----
let greenTotal = 0;
for (const c of rows) if (isGreen(c)) greenTotal++;

// ---- Pattern stats ----
const conditions = {
  'close > prev HIGH (your pattern)': (prev, cur) => cur.close > prev.high,
  'close > prev high AND green body': (prev, cur) => cur.close > prev.high && isGreen(cur),
  'bullish engulfing (body engulfs prev body)': (prev, cur) =>
    isGreen(cur) && !isGreen(prev) && cur.close > prev.open && cur.open < prev.close,
  'plain green candle (control)': (prev, cur) => isGreen(cur),
};

console.log(`File: ${file}  |  Candles: ${rows.length}  |  ${rows[0].date} -> ${rows[rows.length - 1].date}`);
console.log(`Baseline: ${greenTotal}/${rows.length} candles are green = ${pct(greenTotal, rows.length)}%\n`);

for (const [name, test] of Object.entries(conditions)) {
  let signals = 0, nextGreen = 0, sumNextRet = 0;
  let wins = 0, losses = 0, cumRet = 1;
  const nextRets = [];

  for (let i = 1; i < rows.length - 1; i++) {
    const prev = rows[i - 1], cur = rows[i], next = rows[i + 1];
    if (!test(prev, cur)) continue;
    signals++;
    if (isGreen(next)) nextGreen++;
    // Trade simulation: buy next candle's open, sell next candle's close
    const ret = (next.close - next.open) / next.open;
    nextRets.push(ret);
    sumNextRet += ret;
    ret > 0 ? wins++ : losses++;
    cumRet *= 1 + ret;
  }

  const avg = sumNextRet / signals;
  nextRets.sort((a, b) => a - b);
  const median = nextRets[Math.floor(nextRets.length / 2)];

  console.log(`── ${name}`);
  console.log(`   signals: ${signals}  |  next candle green: ${nextGreen}/${signals} = ${pct(nextGreen, signals)}%`);
  console.log(`   next-candle open->close: avg ${(avg * 100).toFixed(3)}%  median ${(median * 100).toFixed(3)}%`);
  console.log(`   cumulative if traded every signal (no fees): ${((cumRet - 1) * 100).toFixed(1)}%\n`);
}

// ---- Hold duration: buy next open after signal, hold N candles ----
console.log('── Hold duration after your pattern (buy next open, hold N candles, no fees)');
for (const hold of [1, 2, 3, 5, 10]) {
  let signals = 0, wins = 0, sum = 0, cum = 1;
  for (let i = 1; i < rows.length - hold - 1; i++) {
    if (rows[i].close <= rows[i - 1].high) continue;
    const entry = rows[i + 1].open, exit = rows[i + hold].close;
    const ret = (exit - entry) / entry;
    signals++;
    if (ret > 0) wins++;
    sum += ret;
    cum *= 1 + ret;
  }
  console.log(`   hold ${String(hold).padStart(2)}: ${signals} trades, win rate ${pct(wins, signals)}%, avg ${((sum / signals) * 100).toFixed(3)}%, cumulative ${((cum - 1) * 100).toFixed(0)}%`);
}
console.log('   (overlapping signals compound in cumulative — treat it as directional, not equity)\n');

// ---- Does follow-through depend on how strong the breakout candle is? ----
console.log('── Breakout strength buckets (your pattern, by candle body size)');
const buckets = [[0, 1], [1, 2], [2, 4], [4, 100]];
for (const [lo, hi] of buckets) {
  let signals = 0, nextGreen = 0, sum = 0;
  for (let i = 1; i < rows.length - 1; i++) {
    const prev = rows[i - 1], cur = rows[i], next = rows[i + 1];
    if (cur.close <= prev.high) continue;
    const body = ((cur.close - cur.open) / cur.open) * 100;
    if (body < lo || body >= hi) continue;
    signals++;
    if (isGreen(next)) nextGreen++;
    sum += (next.close - next.open) / next.open;
  }
  if (signals > 0)
    console.log(`   body ${lo}%-${hi === 100 ? '+' : hi + '%'}: ${signals} signals, next green ${pct(nextGreen, signals)}%, avg next ret ${((sum / signals) * 100).toFixed(3)}%`);
}
