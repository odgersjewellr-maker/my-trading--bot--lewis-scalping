/**
 * Scalp Backtest — VWAP + RSI(3) + EMA(8), baseline vs Valentini-enhanced.
 *
 * Baseline  = rules.json v1: bias (VWAP + EMA8) + RSI(3) trigger, 0.3% stop,
 *             RSI-50 cross exit, 1.5% VWAP overextension filter.
 * Enhanced  = adds Fabio Valentini's auction-market layers:
 *             LOCATION   — entry only within 0.25% of prev-session POC/VAH/VAL
 *             AGGRESSION — approximated delta must agree + volume > 20-bar avg
 *             TARGET     — prev-session POC or 2x stop distance (min 2:1 R:R)
 *             ABSORPTION — early exit when an absorption candle prints against us
 *             BREAKER    — stop for the day after 3 losing trades
 *             ACTIVITY   — only trade when rolling 1h volume > trailing 24h median
 *
 * Usage: node backtest-scalp.js <intraday-csv>      (from fetch-binance-intraday.js)
 *        node backtest-scalp.js --synthetic         (mechanics check on generated data)
 *
 * Fees default to 0.05% per side (override: FEE_PCT=0.1 node backtest-scalp.js ...).
 */

import { readFileSync, existsSync } from "fs";

const FEE_PCT = parseFloat(process.env.FEE_PCT ?? "0.05") / 100; // per side
const START_CASH = 1000;

// ─── Data loading ─────────────────────────────────────────────────────────────

function loadCsv(path) {
  const lines = readFileSync(path, "utf8").trim().split("\n").slice(1);
  return lines.map(l => {
    const [ts, open, high, low, close, volume] = l.split(",");
    return {
      ts: new Date(ts.trim()).getTime(),
      open: parseFloat(open), high: parseFloat(high),
      low: parseFloat(low), close: parseFloat(close),
      volume: parseFloat(volume),
    };
  }).filter(c => !isNaN(c.close) && !isNaN(c.ts));
}

// Scripted impulse/stall/shallow-pullback waves — the only shape that produces
// the strategy's signature setup (RSI(3) tanked while price holds above EMA(8)).
// A plain random walk never co-produces those two conditions, so scripted data
// is required to exercise the engine. Mechanics validation only, not edge.
function syntheticCandles(days = 20) {
  const out = [];
  let price = 60000;
  const start = Date.UTC(2026, 0, 1);
  const bars = days * 1440;
  const wave = dir => {
    const drifts = [];
    for (let i = 0; i < 10; i++) drifts.push(dir * 0.004 * (0.8 + Math.random() * 0.4));  // impulse
    for (let i = 0; i < 2; i++) drifts.push(dir * 0.0002);                                 // stall
    for (let i = 0; i < 3; i++) drifts.push(-dir * 0.0035 * (0.8 + Math.random() * 0.4)); // shallow pullback
    for (let i = 0; i < 5; i++) drifts.push(dir * 0.001);                                  // resume
    return drifts;
  };
  while (out.length < bars) {
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (const drift of wave(dir)) {
      const hourUtc = Math.floor((out.length % 1440) / 60);
      const active = hourUtc >= 13 && hourUtc <= 21; // fake "NY session" volume bump
      const open = price;
      const close = price * (1 + drift + (Math.random() - 0.5) * 0.0002);
      const high = Math.max(open, close) * (1 + Math.random() * 0.0003);
      const low = Math.min(open, close) * (1 - Math.random() * 0.0003);
      out.push({ ts: start + out.length * 60e3, open, high, low, close, volume: (active ? 80 : 25) * (0.5 + Math.random()) });
      price = close;
      if (out.length >= bars) break;
    }
    if (price > 66000) price *= 0.999; // soft anchor keeps price near the profile
    if (price < 54000) price *= 1.001;
  }
  return out;
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let ema = null;
  for (let i = 0; i < values.length; i++) {
    ema = ema == null ? values[i] : values[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function rsiSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const gain = Math.max(ch, 0), loss = Math.max(-ch, 0);
    if (i <= period) {
      avgGain += gain / period; avgLoss += loss / period;
      if (i === period) out[i] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss));
    }
  }
  return out;
}

function atrSeries(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  let atr = null;
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (i <= period) {
      atr = (atr ?? 0) + tr / period;
      if (i === period) out[i] = atr;
    } else {
      atr = (atr * (period - 1) + tr) / period;
      out[i] = atr;
    }
  }
  return out;
}

// Session VWAP, resets at midnight UTC (matches rules.json).
function vwapSeries(candles) {
  const out = new Array(candles.length).fill(null);
  let pv = 0, v = 0, day = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = Math.floor(c.ts / 86400e3);
    if (d !== day) { day = d; pv = 0; v = 0; }
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume; v += c.volume;
    out[i] = v > 0 ? pv / v : c.close;
  }
  return out;
}

// Approximated delta: volume signed by where the close sits in the range.
function deltaApprox(c) {
  const range = c.high - c.low;
  if (range <= 0) return 0;
  return c.volume * ((c.close - c.low) - (c.high - c.close)) / range;
}

// Previous-UTC-session volume profile → { poc, vah, val } per day index.
function sessionProfiles(candles, bins = 50) {
  const byDay = new Map();
  for (const c of candles) {
    const d = Math.floor(c.ts / 86400e3);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(c);
  }
  const profiles = new Map();
  for (const [d, cs] of byDay) {
    const lo = Math.min(...cs.map(c => c.low));
    const hi = Math.max(...cs.map(c => c.high));
    if (hi <= lo) continue;
    const hist = new Array(bins).fill(0);
    for (const c of cs) {
      const typical = (c.high + c.low + c.close) / 3;
      const b = Math.min(bins - 1, Math.max(0, Math.floor(((typical - lo) / (hi - lo)) * bins)));
      hist[b] += c.volume;
    }
    const total = hist.reduce((a, b) => a + b, 0);
    let pocBin = 0;
    for (let b = 1; b < bins; b++) if (hist[b] > hist[pocBin]) pocBin = b;
    // expand from POC until 70% of volume is inside the value area
    let inArea = hist[pocBin], loB = pocBin, hiB = pocBin;
    while (inArea < total * 0.7 && (loB > 0 || hiB < bins - 1)) {
      const below = loB > 0 ? hist[loB - 1] : -1;
      const above = hiB < bins - 1 ? hist[hiB + 1] : -1;
      if (above >= below) { hiB++; inArea += hist[hiB]; } else { loB--; inArea += hist[loB]; }
    }
    const binPrice = b => lo + ((b + 0.5) / bins) * (hi - lo);
    profiles.set(d, { poc: binPrice(pocBin), vah: binPrice(hiB), val: binPrice(loB) });
  }
  return profiles;
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

function run(candles, opts) {
  const closes = candles.map(c => c.close);
  const ema8 = emaSeries(closes, 8);
  const rsi3 = rsiSeries(closes, 3);
  const atr14 = atrSeries(candles, 14);
  const vwap = vwapSeries(candles);
  const volSma20 = emaSeries(candles.map(c => c.volume), 20);
  const profiles = opts.location ? sessionProfiles(candles) : null;

  // rolling 1h volume + trailing 24h median of hourly volume (activity filter)
  const intervalMs = candles[1].ts - candles[0].ts;
  const barsPerHour = Math.max(1, Math.round(3600e3 / intervalMs));

  let cash = START_CASH, peak = START_CASH, maxDD = 0;
  let pos = null, trades = [], fees = 0;
  let dayKey = null, lossesToday = 0, breakerTrips = 0;
  const rejected = { location: 0, aggression: 0, overextended: 0, activity: 0, breaker: 0 };

  const hourlyVol = [];
  let rollSum = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    rollSum += c.volume;
    if (i >= barsPerHour) rollSum -= candles[i - barsPerHour].volume;
    if (i % barsPerHour === 0 && i > 0) {
      hourlyVol.push(rollSum);
      if (hourlyVol.length > 24) hourlyVol.shift();
    }

    const d = Math.floor(c.ts / 86400e3);
    if (d !== dayKey) { dayKey = d; lossesToday = 0; }

    // ── manage open position ──
    if (pos) {
      let exit = null, reason = null;
      if (pos.side === "long") {
        if (c.low <= pos.stop) { exit = pos.stop; reason = "stop"; }
        else if (pos.target && c.high >= pos.target) { exit = pos.target; reason = "target"; }
        else if (!pos.target && rsi3[i] != null && rsi3[i] > 50) { exit = c.close; reason = "rsi50"; }
        else if (pos.target && rsi3[i] != null && rsi3[i] > 50 && c.close > pos.entry) { exit = c.close; reason = "rsi50"; }
      } else {
        if (c.high >= pos.stop) { exit = pos.stop; reason = "stop"; }
        else if (pos.target && c.low <= pos.target) { exit = pos.target; reason = "target"; }
        else if (!pos.target && rsi3[i] != null && rsi3[i] < 50) { exit = c.close; reason = "rsi50"; }
        else if (pos.target && rsi3[i] != null && rsi3[i] < 50 && c.close < pos.entry) { exit = c.close; reason = "rsi50"; }
      }
      // absorption against the position → get out at close
      if (!exit && opts.absorption && atr14[i] != null && volSma20[i] > 0) {
        const isAbsorption = c.volume > 2.0 * volSma20[i] && (c.high - c.low) < 0.3 * atr14[i];
        const against = pos.side === "long" ? deltaApprox(c) < 0 : deltaApprox(c) > 0;
        if (isAbsorption && against) { exit = c.close; reason = "absorption"; }
      }
      if (exit != null) {
        const gross = pos.side === "long"
          ? (exit - pos.entry) / pos.entry * pos.size
          : (pos.entry - exit) / pos.entry * pos.size;
        const fee = pos.size * FEE_PCT * 2;
        const pnl = gross - fee;
        fees += fee;
        cash += pnl;
        trades.push({ ...pos, exit, reason, pnl, ts: c.ts });
        if (pnl < 0) lossesToday++;
        pos = null;
        peak = Math.max(peak, cash);
        maxDD = Math.max(maxDD, (peak - cash) / peak);
        if (cash <= 0) break;
      }
    }

    // ── look for entry ──
    if (pos || i < 20 || rsi3[i] == null || atr14[i] == null) continue;

    const biasLong = c.close > vwap[i] && c.close > ema8[i];
    const biasShort = c.close < vwap[i] && c.close < ema8[i];
    const trigLong = biasLong && rsi3[i] < 30;
    const trigShort = biasShort && rsi3[i] > 70;
    if (!trigLong && !trigShort) continue;

    // shared guardrail: 1.5% VWAP overextension
    if (Math.abs(c.close - vwap[i]) / vwap[i] > 0.015) { rejected.overextended++; continue; }

    if (opts.breaker && lossesToday >= 3) { rejected.breaker++; if (lossesToday === 3) breakerTrips++; continue; }

    if (opts.activity && hourlyVol.length >= 8) {
      const sorted = [...hourlyVol].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      if (rollSum < median) { rejected.activity++; continue; }
    }

    let target = null;
    if (opts.location) {
      const prof = profiles.get(d - 1);
      if (!prof) { rejected.location++; continue; }
      const near = [prof.poc, prof.vah, prof.val].some(
        lvl => Math.abs(c.close - lvl) / c.close < 0.0025
      );
      if (!near) { rejected.location++; continue; }
      target = prof.poc;
    }

    if (opts.aggression) {
      const delta = deltaApprox(c);
      const volOk = c.volume > volSma20[i];
      const agrees = trigLong ? delta > 0 : delta < 0;
      if (!volOk || !agrees) { rejected.aggression++; continue; }
    }

    const side = trigLong ? "long" : "short";
    const entry = c.close;
    const stopDist = entry * 0.003;
    const stop = side === "long" ? entry - stopDist : entry + stopDist;

    // POC target only if it's in the profitable direction and ≥ 2:1; else 2x stop
    if (target != null) {
      const tgtDist = side === "long" ? target - entry : entry - target;
      if (tgtDist < stopDist * 2) target = side === "long" ? entry + stopDist * 2 : entry - stopDist * 2;
    } else if (opts.location || opts.aggression) {
      target = side === "long" ? entry + stopDist * 2 : entry - stopDist * 2;
    }

    const riskUsd = cash * (opts.riskPct / 100);
    const size = Math.min(riskUsd / 0.003, cash); // stop is 0.3% of entry; cap at 1x account
    pos = { side, entry, stop, target, size, entryTs: c.ts };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const grossW = wins.reduce((a, t) => a + t.pnl, 0);
  const grossL = Math.abs(trades.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0));
  return {
    cash, trades, fees, maxDD, breakerTrips, rejected,
    winRate: trades.length ? wins.length / trades.length : 0,
    pf: grossL > 0 ? grossW / grossL : (grossW > 0 ? Infinity : 0),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const arg = process.argv[2];
let candles, label;
if (arg === "--synthetic") {
  candles = syntheticCandles(20);
  label = "SYNTHETIC scripted impulse/pullback data — mechanics check ONLY, results are meaningless as edge";
} else if (arg && existsSync(arg)) {
  candles = loadCsv(arg);
  label = arg;
} else {
  console.error("Usage: node backtest-scalp.js <intraday-csv>   (from fetch-binance-intraday.js)");
  console.error("       node backtest-scalp.js --synthetic      (mechanics validation)");
  process.exit(1);
}

const intervalMin = Math.round((candles[1].ts - candles[0].ts) / 60e3);
const days = ((candles[candles.length - 1].ts - candles[0].ts) / 86400e3).toFixed(1);

console.log("═".repeat(66));
console.log("  Scalp Backtest — baseline vs Valentini-enhanced");
console.log("═".repeat(66));
console.log(`  Data: ${label}`);
console.log(`  ${candles.length} candles | ${intervalMin}m interval | ${days} days | fee ${FEE_PCT * 100}%/side\n`);

const variants = [
  ["Baseline (v1 rules)", { riskPct: 1.0 }],
  ["+ Aggression only", { riskPct: 0.5, aggression: true }],
  ["+ Location only", { riskPct: 0.5, location: true }],
  ["Enhanced (all layers)", { riskPct: 0.5, location: true, aggression: true, absorption: true, breaker: true, activity: true }],
];

const rows = [];
for (const [name, opts] of variants) {
  const r = run(candles, opts);
  rows.push([name, r]);
  console.log(`  ${name}`);
  console.log(`    End: $${r.cash.toFixed(2)} (${((r.cash / START_CASH - 1) * 100).toFixed(1)}%) | trades ${r.trades.length} | win ${(r.winRate * 100).toFixed(1)}% | PF ${r.pf === Infinity ? "∞" : r.pf.toFixed(2)} | maxDD ${(r.maxDD * 100).toFixed(1)}% | fees $${r.fees.toFixed(2)}`);
  const rej = Object.entries(r.rejected).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ");
  if (rej) console.log(`    Signals filtered out: ${rej}${r.breakerTrips ? ` | breaker tripped ${r.breakerTrips} day(s)` : ""}`);
  console.log();
}

const base = rows[0][1], enh = rows[rows.length - 1][1];
console.log("─".repeat(66));
console.log(`  Enhanced vs baseline: ${((enh.cash - base.cash) / START_CASH * 100).toFixed(1)}pp return difference, ` +
  `${enh.trades.length - base.trades.length} trades difference`);
if (arg === "--synthetic") console.log("  ⚠ Synthetic data — use fetch-binance-intraday.js for a real verdict.");
console.log("═".repeat(66));
