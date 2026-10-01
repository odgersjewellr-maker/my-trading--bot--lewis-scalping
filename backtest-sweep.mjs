/**
 * Daily Sweep strategy backtest — session liquidity sweeps vs. previous-day high/low.
 * See docs/daily-sweep-strategy.md for the rules.
 *
 * Usage:
 *   node backtest-sweep.mjs --fetch [SYMBOL]          # download 1h candles from Binance -> <symbol>-1h.csv
 *   node backtest-sweep.mjs [csv-path] [--verbose]    # run with default config
 *   node backtest-sweep.mjs [csv-path] --optimize     # small grid search, ranked by total R
 *
 * CSV format (header row skipped): ts_ms,open,high,low,close,volume  (1h candles, oldest first, UTC)
 *
 * Research only — not wired into bot.js. Nothing here places orders.
 */

import { readFileSync, writeFileSync } from "fs";
import https from "https";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const positional = args.filter((a) => !a.startsWith("--"));

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_CFG = {
  // Sessions in UTC hours [start, end)
  asia:   [0, 7],
  london: [7, 12],
  ny:     [12, 20],
  flatHour: 20,          // force-close any open trade at this UTC hour's open
  levels: ["asia", "pd"], // liquidity to watch: Asia high/low and/or previous-day high/low
  bias: "daily",         // "daily" = only trade with the previous daily candle; "none" = both ways
  reclaimBars: 3,        // after the sweep, the H1 close must reclaim the level within this many bars
  stopBufferPct: 0.05,   // extra % beyond the sweep wick for the stop
  minRiskPct: 0.15,      // skip if stop distance < this % of price (too tight, fees eat it)
  maxRiskPct: 2.0,       // skip if stop distance > this % of price
  target: "opposite",    // "opposite" = opposite side liquidity (PDH for longs / PDL for shorts), "rr" = fixed R
  rr: 2.0,               // R multiple for target "rr", and minimum R for "opposite" (else falls back to rr)
  feePct: 0.06,          // round-trip fees + slippage, % of notional
  maxTradesPerDay: 1,
};

// ─── Data ─────────────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function fetchCandles(symbol, from = "2022-01-01") {
  const out = [];
  let start = new Date(from).getTime();
  console.log(`Fetching ${symbol} 1h candles from Binance since ${from}...`);
  while (start < Date.now()) {
    const batch = await get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000&startTime=${start}`);
    if (!Array.isArray(batch) || !batch.length) break;
    for (const k of batch) out.push([k[0], k[1], k[2], k[3], k[4], k[5]].join(","));
    start = batch[batch.length - 1][0] + 3600_000;
  }
  const file = `${symbol.toLowerCase()}-1h.csv`;
  writeFileSync(file, "ts,open,high,low,close,volume\n" + out.join("\n") + "\n");
  console.log(`Saved ${out.length} candles to ${file}`);
}

function loadCandles(path) {
  return readFileSync(path, "utf8").trim().split("\n").slice(1).map((l) => {
    const [ts, o, h, lo, c] = l.split(",").map(Number);
    return { ts, open: o, high: h, low: lo, close: c, hour: new Date(ts).getUTCHours(), day: new Date(ts).toISOString().slice(0, 10) };
  }).filter((c) => !isNaN(c.close));
}

function groupByDay(candles) {
  const days = new Map();
  for (const c of candles) {
    if (!days.has(c.day)) days.set(c.day, []);
    days.get(c.day).push(c);
  }
  return [...days.entries()].map(([day, bars]) => ({
    day, bars,
    open: bars[0].open, close: bars[bars.length - 1].close,
    high: Math.max(...bars.map((b) => b.high)), low: Math.min(...bars.map((b) => b.low)),
  }));
}

// ─── Strategy ─────────────────────────────────────────────────────────────────

function runBacktest(candles, cfg, verbose = false) {
  const days = groupByDay(candles);
  const trades = [];

  for (let d = 1; d < days.length; d++) {
    const prev = days[d - 1], today = days[d];
    if (today.bars.length < 20 || prev.bars.length < 20) continue; // skip gaps / partial days

    const bias = cfg.bias === "none" ? "both" : prev.close > prev.open ? "long" : "short";
    const asiaBars = today.bars.filter((b) => b.hour >= cfg.asia[0] && b.hour < cfg.asia[1]);
    if (!asiaBars.length) continue;
    const asiaHigh = Math.max(...asiaBars.map((b) => b.high));
    const asiaLow  = Math.min(...asiaBars.map((b) => b.low));

    // Liquidity levels price can sweep. Longs sweep lows, shorts sweep highs.
    const lows = [], highs = [];
    if (cfg.levels.includes("asia")) { lows.push({ name: "AsiaLow", px: asiaLow }); highs.push({ name: "AsiaHigh", px: asiaHigh }); }
    if (cfg.levels.includes("pd"))   { lows.push({ name: "PDL", px: prev.low });   highs.push({ name: "PDH", px: prev.high }); }

    const sweeps = []; // active sweeps waiting for a reclaim: { side, level, extreme, barsLeft }
    let pos = null, tradesToday = 0;

    for (const bar of today.bars) {
      if (bar.hour < cfg.london[0]) continue;

      // Manage open position (stop checked first = conservative when both hit in one bar)
      if (pos) {
        let exit = null, reason = null;
        if (bar.hour >= cfg.flatHour) { exit = bar.open; reason = "time"; }
        else if (pos.side === "long") {
          if (bar.low <= pos.stop) { exit = pos.stop; reason = "stop"; }
          else if (bar.high >= pos.target) { exit = pos.target; reason = "target"; }
        } else {
          if (bar.high >= pos.stop) { exit = pos.stop; reason = "stop"; }
          else if (bar.low <= pos.target) { exit = pos.target; reason = "target"; }
        }
        if (exit != null) {
          const move = pos.side === "long" ? exit - pos.entry : pos.entry - exit;
          const feeR = (pos.entry * cfg.feePct / 100) / pos.risk;
          trades.push({ ...pos, exit, reason, exitTs: bar.ts, r: move / pos.risk - feeR });
          pos = null;
        }
        continue;
      }
      if (bar.hour >= cfg.ny[1] || tradesToday >= cfg.maxTradesPerDay) continue;

      // 1) Detect new sweeps: wick through the level during London/NY
      if (bias !== "short") for (const lv of lows) {
        if (bar.low < lv.px && !sweeps.some((s) => s.level === lv)) sweeps.push({ side: "long", level: lv, extreme: bar.low, barsLeft: cfg.reclaimBars });
      }
      if (bias !== "long") for (const lv of highs) {
        if (bar.high > lv.px && !sweeps.some((s) => s.level === lv)) sweeps.push({ side: "short", level: lv, extreme: bar.high, barsLeft: cfg.reclaimBars });
      }

      // 2) Look for an H1 close back inside the level (the reclaim) -> entry at close
      for (const s of sweeps) {
        if (s.barsLeft <= 0) continue;
        s.extreme = s.side === "long" ? Math.min(s.extreme, bar.low) : Math.max(s.extreme, bar.high);
        const reclaimed = s.side === "long" ? bar.close > s.level.px : bar.close < s.level.px;
        s.barsLeft--;
        if (!reclaimed) continue;
        s.barsLeft = 0;

        const entry = bar.close;
        const stop = s.side === "long" ? s.extreme * (1 - cfg.stopBufferPct / 100) : s.extreme * (1 + cfg.stopBufferPct / 100);
        const risk = Math.abs(entry - stop);
        const riskPct = (risk / entry) * 100;
        if (riskPct < cfg.minRiskPct || riskPct > cfg.maxRiskPct) continue;

        let target = s.side === "long" ? entry + cfg.rr * risk : entry - cfg.rr * risk;
        if (cfg.target === "opposite") {
          // Draw on liquidity: the far side of the previous day's range
          const opp = s.side === "long" ? Math.max(prev.high, asiaHigh) : Math.min(prev.low, asiaLow);
          const oppR = s.side === "long" ? (opp - entry) / risk : (entry - opp) / risk;
          if (oppR >= cfg.rr) target = opp;
        }
        pos = { day: today.day, side: s.side, swept: s.level.name, entryTs: bar.ts, entry, stop, target, risk };
        tradesToday++;
        break;
      }
    }
    // Day ended with position still open (shouldn't happen with flatHour < 24, but be safe)
    if (pos) {
      const last = today.bars[today.bars.length - 1];
      const move = pos.side === "long" ? last.close - pos.entry : pos.entry - last.close;
      trades.push({ ...pos, exit: last.close, reason: "eod", exitTs: last.ts, r: move / pos.risk - (pos.entry * cfg.feePct / 100) / pos.risk });
    }
  }

  return summarize(trades, verbose);
}

function summarize(trades, verbose) {
  let equity = 0, peak = 0, maxDD = 0, grossWin = 0, grossLoss = 0;
  for (const t of trades) {
    equity += t.r; peak = Math.max(peak, equity); maxDD = Math.max(maxDD, peak - equity);
    if (t.r > 0) grossWin += t.r; else grossLoss -= t.r;
    if (verbose) console.log(`${t.day} ${t.side.padEnd(5)} swept ${t.swept.padEnd(8)} entry ${t.entry.toFixed(2)} stop ${t.stop.toFixed(2)} tgt ${t.target.toFixed(2)} -> ${t.reason.padEnd(6)} ${t.r >= 0 ? "+" : ""}${t.r.toFixed(2)}R`);
  }
  const wins = trades.filter((t) => t.r > 0).length;
  return {
    trades: trades.length,
    winRate: trades.length ? (wins / trades.length) * 100 : 0,
    totalR: equity,
    avgR: trades.length ? equity / trades.length : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : grossWin ? Infinity : 0,
    maxDDR: maxDD,
    bySwept: Object.fromEntries([...new Set(trades.map((t) => t.swept))].map((k) => {
      const ts = trades.filter((t) => t.swept === k);
      return [k, { n: ts.length, totalR: +ts.reduce((a, t) => a + t.r, 0).toFixed(2) }];
    })),
  };
}

function fmt(s) {
  return `trades ${s.trades}  win ${s.winRate.toFixed(1)}%  total ${s.totalR.toFixed(1)}R  avg ${s.avgR.toFixed(3)}R  PF ${s.profitFactor.toFixed(2)}  maxDD ${s.maxDDR.toFixed(1)}R`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

if (flag("--fetch")) {
  await fetchCandles((positional[0] || "BTCUSDT").toUpperCase());
} else {
  const path = positional[0] || "btcusdt-1h.csv";
  const candles = loadCandles(path);
  console.log(`Loaded ${candles.length} 1h candles from ${path}`);

  if (flag("--optimize")) {
    const results = [];
    for (const levels of [["asia"], ["pd"], ["asia", "pd"]])
      for (const bias of ["daily", "none"])
        for (const target of ["opposite", "rr"])
          for (const rr of [1.5, 2, 3])
            for (const reclaimBars of [1, 3]) {
              const cfg = { ...DEFAULT_CFG, levels, bias, target, rr, reclaimBars };
              const s = runBacktest(candles, cfg);
              if (s.trades >= 30) results.push({ cfg, s });
            }
    results.sort((a, b) => b.s.totalR - a.s.totalR);
    console.log("\nTop 10 configs (min 30 trades) — beware overfitting, check out-of-sample:\n");
    for (const { cfg, s } of results.slice(0, 10))
      console.log(`levels=${cfg.levels.join("+").padEnd(7)} bias=${cfg.bias.padEnd(5)} target=${cfg.target.padEnd(8)} rr=${cfg.rr} reclaim=${cfg.reclaimBars} | ${fmt(s)}`);
  } else {
    const s = runBacktest(candles, DEFAULT_CFG, flag("--verbose"));
    console.log("\n" + fmt(s));
    console.log("By level swept:", s.bySwept);
  }
}
