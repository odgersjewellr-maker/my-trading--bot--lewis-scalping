// pattern-scanner.js
// Scans historical candles for classic candlestick patterns and measures
// what actually happened next: % of time the next candle was green (bull
// patterns) or red (bear patterns), average follow-through returns, and
// whether combining patterns with a trend filter improves the edge.
//
// Usage: node pattern-scanner.js [csv-file] [--hold N]
// CSV format: Date,Open,High,Low,Close,Volume
//
// Bull patterns are scored long (buy next open); bear patterns are scored
// short (sell next open). All returns are next-open -> exit-close, no fees.

const fs = require('fs');

const args = process.argv.slice(2);
const holdIdx = args.indexOf('--hold');
const HOLD = holdIdx >= 0 ? parseInt(args[holdIdx + 1], 10) : 3;
const file = args.find((a, i) => !a.startsWith('--') && i !== holdIdx + 1) || 'btc-daily-binance.csv';

const rows = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map(l => {
  const [date, open, high, low, close, volume] = l.split(',');
  return { date, open: +open, high: +high, low: +low, close: +close, volume: +volume };
});

// ---------- helpers ----------
const green = c => c.close > c.open;
const red = c => c.close < c.open;
const body = c => Math.abs(c.close - c.open);
const range = c => c.high - c.low || 1e-9;
const upperWick = c => c.high - Math.max(c.open, c.close);
const lowerWick = c => Math.min(c.open, c.close) - c.low;

// SMA of closes, aligned so sma[i] uses candles i-n+1 .. i
function sma(n) {
  const out = new Array(rows.length).fill(null);
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    sum += rows[i].close;
    if (i >= n) sum -= rows[i - n].close;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
const sma50 = sma(50);

// RSI(14) on closes
function rsi(n) {
  const out = new Array(rows.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < rows.length; i++) {
    const ch = rows[i].close - rows[i - 1].close;
    const gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
    if (i <= n) {
      avgGain += gain / n; avgLoss += loss / n;
      if (i === n) out[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-9));
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
      out[i] = 100 - 100 / (1 + avgGain / (avgLoss || 1e-9));
    }
  }
  return out;
}
const rsi14 = rsi(14);

// ---------- pattern definitions ----------
// Each test receives index i of the signal candle (the last candle of the
// pattern). It may look back at rows[i-1], rows[i-2] etc.
const P = (name, dir, test) => ({ name, dir, test });

const patterns = [
  // --- two-candle momentum (your original + mirror) ---
  P('Close above prev HIGH', 'bull', i => rows[i].close > rows[i - 1].high),
  P('Close below prev LOW', 'bear', i => rows[i].close < rows[i - 1].low),

  // --- engulfing ---
  P('Bullish engulfing', 'bull', i => {
    const p = rows[i - 1], c = rows[i];
    return green(c) && red(p) && c.close > p.open && c.open < p.close;
  }),
  P('Bearish engulfing', 'bear', i => {
    const p = rows[i - 1], c = rows[i];
    return red(c) && green(p) && c.close < p.open && c.open > p.close;
  }),

  // --- single-candle reversal shapes (need prior move for context) ---
  P('Hammer (after 3 down closes)', 'bull', i => {
    const c = rows[i];
    const downMove = rows[i - 1].close < rows[i - 2].close && rows[i - 2].close < rows[i - 3].close;
    return downMove && lowerWick(c) > 2 * body(c) && upperWick(c) < body(c);
  }),
  P('Shooting star (after 3 up closes)', 'bear', i => {
    const c = rows[i];
    const upMove = rows[i - 1].close > rows[i - 2].close && rows[i - 2].close > rows[i - 3].close;
    return upMove && upperWick(c) > 2 * body(c) && lowerWick(c) < body(c);
  }),
  P('Bull marubozu (full body >2%)', 'bull', i => {
    const c = rows[i];
    return green(c) && body(c) / range(c) > 0.9 && body(c) / c.open > 0.02;
  }),
  P('Bear marubozu (full body >2%)', 'bear', i => {
    const c = rows[i];
    return red(c) && body(c) / range(c) > 0.9 && body(c) / c.open > 0.02;
  }),
  P('Doji (body <10% of range)', 'bull', i => body(rows[i]) / range(rows[i]) < 0.1),

  // --- inside / outside bars ---
  P('Inside bar, then buy', 'bull', i =>
    rows[i].high < rows[i - 1].high && rows[i].low > rows[i - 1].low),
  P('Outside bar closing green', 'bull', i =>
    rows[i].high > rows[i - 1].high && rows[i].low < rows[i - 1].low && green(rows[i])),
  P('Outside bar closing red', 'bear', i =>
    rows[i].high > rows[i - 1].high && rows[i].low < rows[i - 1].low && red(rows[i])),

  // --- piercing / dark cloud ---
  P('Piercing line', 'bull', i => {
    const p = rows[i - 1], c = rows[i];
    return red(p) && green(c) && c.open < p.close && c.close > (p.open + p.close) / 2 && c.close < p.open;
  }),
  P('Dark cloud cover', 'bear', i => {
    const p = rows[i - 1], c = rows[i];
    return green(p) && red(c) && c.open > p.close && c.close < (p.open + p.close) / 2 && c.close > p.open;
  }),

  // --- three-candle ---
  P('Three white soldiers', 'bull', i => {
    const a = rows[i - 2], b = rows[i - 1], c = rows[i];
    return green(a) && green(b) && green(c) && b.close > a.close && c.close > b.close &&
      body(b) / range(b) > 0.5 && body(c) / range(c) > 0.5;
  }),
  P('Three black crows', 'bear', i => {
    const a = rows[i - 2], b = rows[i - 1], c = rows[i];
    return red(a) && red(b) && red(c) && b.close < a.close && c.close < b.close &&
      body(b) / range(b) > 0.5 && body(c) / range(c) > 0.5;
  }),
  P('Morning star', 'bull', i => {
    const a = rows[i - 2], b = rows[i - 1], c = rows[i];
    return red(a) && body(a) / range(a) > 0.5 &&
      body(b) / range(b) < 0.3 &&
      green(c) && c.close > (a.open + a.close) / 2;
  }),
  P('Evening star', 'bear', i => {
    const a = rows[i - 2], b = rows[i - 1], c = rows[i];
    return green(a) && body(a) / range(a) > 0.5 &&
      body(b) / range(b) < 0.3 &&
      red(c) && c.close < (a.open + a.close) / 2;
  }),

  // --- indicator-context signals (for combos) ---
  P('RSI < 30, first close up', 'bull', i =>
    rsi14[i - 1] !== null && rsi14[i - 1] < 30 && green(rows[i])),
  P('RSI > 70, first close down', 'bear', i =>
    rsi14[i - 1] !== null && rsi14[i - 1] > 70 && red(rows[i])),
];

// ---------- scoring ----------
// Long: buy next open, exit close of candle i+hold.
// Short: sell next open, cover close of candle i+hold (return is negated move).
function score(test, dir, { trendFilter = null, hold = HOLD } = {}) {
  let n = 0, favNext = 0, wins = 0, sumRet = 0;
  const start = 51; // room for lookback + SMA50
  for (let i = start; i < rows.length - hold - 1; i++) {
    if (!test(i)) continue;
    if (trendFilter && !trendFilter(i)) continue;
    n++;
    const next = rows[i + 1];
    if (dir === 'bull' ? green(next) : red(next)) favNext++;
    const entry = rows[i + 1].open, exit = rows[i + hold].close;
    let ret = (exit - entry) / entry;
    if (dir === 'bear') ret = -ret;
    if (ret > 0) wins++;
    sumRet += ret;
  }
  return { n, favNext, wins, avg: n ? sumRet / n : 0 };
}

const pct = (a, b) => b ? ((a / b) * 100).toFixed(1) : '-';
const fmt = (s, dir) =>
  `${String(s.n).padStart(4)} sig | next ${dir === 'bull' ? 'green' : 'red '} ${pct(s.favNext, s.n).padStart(5)}% | ` +
  `hold-${HOLD} win ${pct(s.wins, s.n).padStart(5)}% avg ${(s.avg * 100).toFixed(2).padStart(6)}%`;

// baseline
let greens = 0;
for (const c of rows) if (green(c)) greens++;
const baseDrift = score(() => true, 'bull');

console.log(`File: ${file} | ${rows.length} candles | ${rows[0].date} -> ${rows[rows.length - 1].date}`);
console.log(`Hold: ${HOLD} candles (change with --hold N)`);
console.log(`Baseline: ${pct(greens, rows.length)}% of candles green | any-day long ${fmt(baseDrift, 'bull').split('| ').slice(1).join('| ')}`);
console.log(`Reliability note: < 50 signals = mostly noise, treat with suspicion.\n`);

console.log('=== RAW PATTERNS ===');
for (const p of patterns) {
  console.log(`${p.name.padEnd(34)} [${p.dir}] ${fmt(score(p.test, p.dir), p.dir)}`);
}

// ---------- combos: pattern + trend filter ----------
const withTrend = i => rows[i].close > sma50[i];   // for bulls
const againstTrend = i => rows[i].close < sma50[i]; // for bears

console.log('\n=== SAME PATTERNS + TREND FILTER (bulls only above SMA50, bears only below) ===');
for (const p of patterns) {
  const s = score(p.test, p.dir, { trendFilter: p.dir === 'bull' ? withTrend : againstTrend });
  console.log(`${p.name.padEnd(34)} [${p.dir}] ${fmt(s, p.dir)}`);
}

// ---------- confluence: multiple bull signals on the same candle ----------
console.log('\n=== CONFLUENCE: number of bull patterns firing on the same candle ===');
for (const minK of [1, 2, 3]) {
  const test = i => patterns.filter(p => p.dir === 'bull' && p.test(i)).length >= minK;
  console.log(`>= ${minK} bull patterns${' '.repeat(17)} ${fmt(score(test, 'bull'), 'bull')}`);
}
console.log('');
for (const minK of [1, 2, 3]) {
  const test = i => patterns.filter(p => p.dir === 'bear' && p.test(i)).length >= minK;
  console.log(`>= ${minK} bear patterns${' '.repeat(17)} ${fmt(score(test, 'bear'), 'bear')}`);
}
