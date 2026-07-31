/**
 * Daily Range Breakout — "failed breakout" reversal strategy.
 *
 * The idea (from a prior-day-range trading video, ~70%+ win rate reported on
 * SOL/USDT intraday):
 *
 *   1. Take the previous completed day's high and low. That's the box.
 *      The midpoint of the box is just a visual reference line.
 *   2. Wait for a candle to CLOSE outside the box (a "breakout" close beyond
 *      the prior day's high or low).
 *   3. If the very next candle CLOSES back inside the box, that breakout was
 *      a failure / liquidity grab — trade the reversal back into the range.
 *   4. Stop goes just beyond the breakout candle's wick. Target is a fixed
 *      reward:risk multiple (2:1 by default) off that stop distance.
 *
 * This file computes the prior-period high/low box generically from a `date`
 * field on each candle (UTC calendar day by default), so it works correctly
 * whether you feed it:
 *   - intraday candles (1H etc.) — the box stays fixed for every candle in
 *     the current day, which is the real version of this strategy, or
 *   - daily candles — each "period" is one candle, so the box simply shifts
 *     to the prior day every bar (an outside-day-fade proxy; useful for a
 *     quick sanity backtest when you don't have intraday data on hand).
 *
 * Usage: node daily-range-breakout.js [csv-path] [--optimize]
 *
 * Without --optimize: single backtest with BASE_CFG, full trade log printed.
 * With --optimize:    grid-searches rrMult, stopBufferATR, minBreakoutATR,
 *                      maxHoldBars and ranks by Sharpe.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// ─── Load CSV ─────────────────────────────────────────────────────────────────

const OPTIMIZE = process.argv.includes("--optimize");
const csvPath = process.argv.filter((a) => !a.startsWith("--"))[2] || "btc-daily-binance.csv";

const lines = readFileSync(resolve(csvPath), "utf8").trim().split("\n").slice(1);
const candles = lines
  .map((l) => {
    const [date, open, high, low, close, volume] = l.split(",");
    return {
      date: date.trim(),
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume),
    };
  })
  .filter((c) => !isNaN(c.close));

// ─── Indicator helpers ────────────────────────────────────────────────────────

function calcATRSeries(candles, period) {
  const n = candles.length;
  const tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  const atr = new Array(n).fill(null);
  if (n <= period) return atr;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  return atr;
}

function calcVolumeSMASeries(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].volume;
    out[i] = sum / period;
  }
  return out;
}

// UTC calendar-day key from either "YYYY-MM-DD" or a full ISO timestamp.
function dayKey(dateStr) {
  return dateStr.slice(0, 10);
}

// For each candle, the high/low/mid of the immediately preceding COMPLETED
// day, held fixed for every candle inside the current day.
function attachPrevDayLevels(candles) {
  const n = candles.length;
  const prevHigh = new Array(n).fill(null);
  const prevLow = new Array(n).fill(null);
  const prevMid = new Array(n).fill(null);

  let curKey = null, curHigh = -Infinity, curLow = Infinity;
  let lastCompleted = null;

  for (let i = 0; i < n; i++) {
    const key = dayKey(candles[i].date);
    if (key !== curKey) {
      if (curKey !== null) lastCompleted = { high: curHigh, low: curLow };
      curKey = key;
      curHigh = -Infinity;
      curLow = Infinity;
    }
    if (lastCompleted) {
      prevHigh[i] = lastCompleted.high;
      prevLow[i] = lastCompleted.low;
      prevMid[i] = (lastCompleted.high + lastCompleted.low) / 2;
    }
    curHigh = Math.max(curHigh, candles[i].high);
    curLow = Math.min(curLow, candles[i].low);
  }
  return { prevHigh, prevLow, prevMid };
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

function runBacktest(candles, cfg, verbose = false) {
  const { prevHigh, prevLow, prevMid } = attachPrevDayLevels(candles);
  const atrArr = calcATRSeries(candles, cfg.atrLen);
  const volSMAArr = cfg.useVolumeFilter ? calcVolumeSMASeries(candles, cfg.volumeSMA) : null;
  const n = candles.length;

  let portfolio = 1000;
  let position = null; // { side, entry, qty, stop, target, entryIdx, sizeUSD }
  const usedUp = {};   // one short setup per day (per prior-day box)
  const usedDown = {}; // one long setup per day

  const trades = [];
  const equity = [portfolio];

  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const atr = atrArr[i];
    // ── Manage open position first — check stop/target against this bar's range ──
    if (position) {
      const { side, stop, target } = position;
      let exitPrice = null, exitType = null;

      if (side === "short") {
        const stopHit = c.high >= stop;
        const targetHit = c.low <= target;
        if (stopHit && targetHit) { exitPrice = stop; exitType = "stop"; }       // conservative: stop first
        else if (stopHit) { exitPrice = stop; exitType = "stop"; }
        else if (targetHit) { exitPrice = target; exitType = "target"; }
      } else {
        const stopHit = c.low <= stop;
        const targetHit = c.high >= target;
        if (stopHit && targetHit) { exitPrice = stop; exitType = "stop"; }
        else if (stopHit) { exitPrice = stop; exitType = "stop"; }
        else if (targetHit) { exitPrice = target; exitType = "target"; }
      }

      // Time stop — close at market if neither level hit within maxHoldBars
      if (!exitPrice && cfg.maxHoldBars && i - position.entryIdx >= cfg.maxHoldBars) {
        exitPrice = c.close;
        exitType = "time";
      }

      if (exitPrice != null) {
        const pnl = side === "short"
          ? (position.entry - exitPrice) * position.qty
          : (exitPrice - position.entry) * position.qty;
        portfolio += pnl;
        trades.push({ date: c.date, type: exitType, side, entry: position.entry, exit: exitPrice, pnl, portfolio });
        if (verbose) console.log(`  ${exitType.toUpperCase().padEnd(6)}  ${c.date}  ${side.toUpperCase()} exit $${exitPrice.toFixed(2)}  P&L $${pnl.toFixed(2)}  Portfolio $${portfolio.toFixed(0)}`);
        position = null;
      }
    }

    // ── Look for a new failed-breakout signal (only when flat) ──
    // Anchor both the breakout test and the reclaim test to the box that was
    // active when the breakout candle (prev) printed. For intraday data this
    // is identical to "today's fixed box" since prev and c share the same
    // day. For daily-bar data it's "yesterday broke prior day's high, today
    // closed back under it" — the natural outside-day-fade analog.
    if (!position && prevHigh[i - 1] != null) {
      const pHigh = prevHigh[i - 1];
      const pLow = prevLow[i - 1];
      const pMid = prevMid[i - 1];
      const pKey = dayKey(prev.date);

      const breakoutUp = prev.close > pHigh;
      const breakoutDown = prev.close < pLow;

      const breakoutExtUp = breakoutUp ? prev.close - pHigh : 0;
      const breakoutExtDown = breakoutDown ? pLow - prev.close : 0;
      const minExt = cfg.minBreakoutATR && atr ? cfg.minBreakoutATR * atr : 0;

      const reclaimedDown = breakoutUp && c.close <= pHigh; // failed breakout up -> short
      const reclaimedUp = breakoutDown && c.close >= pLow;  // failed breakout down -> long

      // Optional conviction filter: confirmation close must push back past the
      // box midpoint, not just barely reclaim the level.
      const decisiveShort = !cfg.requireDecisiveClose || c.close <= pHigh - (pHigh - pMid) * cfg.decisiveFrac;
      const decisiveLong = !cfg.requireDecisiveClose || c.close >= pLow + (pMid - pLow) * cfg.decisiveFrac;

      const volOk = !cfg.useVolumeFilter || (volSMAArr[i] != null && c.volume >= volSMAArr[i] * cfg.volumeMult);

      const shortSignal = reclaimedDown && breakoutExtUp >= minExt && decisiveShort && volOk && !usedUp[pKey];
      const longSignal = reclaimedUp && breakoutExtDown >= minExt && decisiveLong && volOk && !usedDown[pKey];

      if (shortSignal || longSignal) {
        const side = shortSignal ? "short" : "long";
        if (shortSignal) usedUp[pKey] = true; else usedDown[pKey] = true;

        const buffer = atr ? atr * cfg.stopBufferATR : Math.abs(pHigh - pLow) * 0.02;
        const entry = c.close;
        const stop = side === "short" ? prev.high + buffer : prev.low - buffer;
        const risk = Math.abs(stop - entry);
        const target = side === "short" ? entry - risk * cfg.rrMult : entry + risk * cfg.rrMult;

        const tradeSize = portfolio * cfg.tradeSizePct;
        const qty = tradeSize / entry;
        position = { side, entry, qty, stop, target, entryIdx: i, sizeUSD: tradeSize };
        if (verbose) console.log(`  OPEN    ${c.date}  ${side.toUpperCase()} $${entry.toFixed(2)}  stop $${stop.toFixed(2)}  target $${target.toFixed(2)}  size $${tradeSize.toFixed(0)}`);
      }
    }

    equity.push(portfolio + (position
      ? (position.side === "short" ? (position.entry - c.close) * position.qty : (c.close - position.entry) * position.qty)
      : 0));
  }

  // Close any open position at the end
  if (position) {
    const price = candles[n - 1].close;
    const pnl = position.side === "short"
      ? (position.entry - price) * position.qty
      : (price - position.entry) * position.qty;
    portfolio += pnl;
    trades.push({ date: candles[n - 1].date, type: "end", side: position.side, entry: position.entry, exit: price, pnl, portfolio });
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  const exits = trades.filter((t) => t.pnl !== undefined);
  const wins = exits.filter((t) => t.pnl > 0);
  const losses = exits.filter((t) => t.pnl <= 0);
  const totalPnl = exits.reduce((s, t) => s + t.pnl, 0);
  const winRate = exits.length ? (wins.length / exits.length * 100).toFixed(1) : 0;
  const avgWin = wins.length ? (wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(0) : 0;
  const avgLoss = losses.length ? (losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(0) : 0;
  const profitFactor = losses.length && losses.reduce((s, t) => s + Math.abs(t.pnl), 0) > 0
    ? (wins.reduce((s, t) => s + t.pnl, 0) / Math.abs(losses.reduce((s, t) => s + t.pnl, 0))).toFixed(2)
    : "∞";

  let peak = equity[0], maxDD = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const dailyReturns = equity.slice(1).map((v, i) => (v - equity[i]) / equity[i]);
  const meanR = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const stdR = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - meanR) ** 2, 0) / dailyReturns.length);
  const sharpe = stdR > 0 ? ((meanR / stdR) * Math.sqrt(365)).toFixed(2) : "N/A";

  return { portfolio, totalPnl, trades: exits.length, winRate, avgWin, avgLoss, profitFactor, maxDD: maxDD.toFixed(1), sharpe };
}

// ─── Single run ───────────────────────────────────────────────────────────────

const BASE_CFG = {
  atrLen: 14,
  rrMult: 2,              // 2:1 reward:risk, per the video
  stopBufferATR: 0.1,     // stop = breakout candle's wick + 0.1 ATR buffer
  minBreakoutATR: 0,      // require breakout to clear the level by N * ATR (0 = off)
  requireDecisiveClose: false,
  decisiveFrac: 0.15,     // confirmation close must push this far back past the level, toward the midpoint
  useVolumeFilter: false,
  volumeSMA: 20,
  volumeMult: 1.0,
  maxHoldBars: 0,         // 0 = no time stop
  tradeSizePct: 0.80,
};

if (!OPTIMIZE) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Daily Range Breakout (failed-breakout reversal) Backtest");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Candles: ${candles.length} bars  |  ${candles[0].date} → ${candles[candles.length - 1].date}`);
  console.log(`  Note: with daily-bar input, the "box" shifts every bar (previous`);
  console.log(`  day's single candle) — an outside-day-fade proxy. Feed intraday`);
  console.log(`  (1H) candles for the true version shown in the reference chart.\n`);

  const rBase = runBacktest(candles, BASE_CFG);
  const rDecisive = runBacktest(candles, { ...BASE_CFG, requireDecisiveClose: true });
  const rVol = runBacktest(candles, { ...BASE_CFG, useVolumeFilter: true });
  const rBoth = runBacktest(candles, { ...BASE_CFG, requireDecisiveClose: true, useVolumeFilter: true });

  const fmt = (r, label) => {
    const ret = ((r.portfolio - 1000) / 10).toFixed(1);
    return `  ${label.padEnd(28)} $${r.portfolio.toFixed(0).padStart(8)}  ${(ret + "%").padStart(8)}  ${String(r.trades).padStart(6)}  ${(r.winRate + "%").padStart(7)}  ${String(r.profitFactor).padStart(5)}  ${(r.maxDD + "%").padStart(7)}  ${r.sharpe}`;
  };

  console.log(`  ${"Label".padEnd(28)} ${"Portfolio".padStart(9)}  ${"Return".padStart(8)}  ${"Trades".padStart(6)}  ${"WinRate".padStart(7)}  ${"PF".padStart(5)}  ${"MaxDD".padStart(7)}  Sharpe`);
  console.log("  " + "─".repeat(96));
  console.log(fmt(rBase, "Base (2:1 R:R)"));
  console.log(fmt(rDecisive, "+ decisive reclaim filter"));
  console.log(fmt(rVol, "+ volume filter"));
  console.log(fmt(rBoth, "+ decisive + volume"));

  console.log("\n── Base config — full trade log ─────────────────────────\n");
  runBacktest(candles, BASE_CFG, true);
  console.log("\n═══════════════════════════════════════════════════════════\n");
}

// ─── Grid optimisation ────────────────────────────────────────────────────────

if (OPTIMIZE) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Daily Range Breakout — Grid Search");
  console.log("═══════════════════════════════════════════════════════════\n");

  const results = [];
  const rrMults = [1.5, 2, 2.5, 3];
  const stopBuffers = [0, 0.1, 0.25, 0.5];
  const minBreakoutATRs = [0, 0.1, 0.25, 0.5];
  const maxHoldBarsArr = [0, 3, 5, 10];

  const total = rrMults.length * stopBuffers.length * minBreakoutATRs.length * maxHoldBarsArr.length;
  let done = 0;

  for (const rrMult of rrMults) {
    for (const stopBufferATR of stopBuffers) {
      for (const minBreakoutATR of minBreakoutATRs) {
        for (const maxHoldBars of maxHoldBarsArr) {
          const cfg = { ...BASE_CFG, rrMult, stopBufferATR, minBreakoutATR, maxHoldBars };
          const r = runBacktest(candles, cfg);
          results.push({ rrMult, stopBufferATR, minBreakoutATR, maxHoldBars, ...r });
          done++;
          if (done % 20 === 0) process.stdout.write(`\r  Progress: ${done}/${total}`);
        }
      }
    }
  }

  results.sort((a, b) => parseFloat(b.sharpe) - parseFloat(a.sharpe));

  console.log("\n\n── Top 10 parameter sets (ranked by Sharpe) ─────────────\n");
  console.log("  rrMult  stopBuf  minBrkATR  maxHold  Return%  WinRate  PF    MaxDD%  Sharpe  Trades");
  console.log("  " + "─".repeat(85));
  for (const r of results.slice(0, 10)) {
    const ret = ((r.portfolio - 1000) / 1000 * 100).toFixed(0);
    console.log(
      `  ${r.rrMult.toFixed(1).padEnd(7)} ${r.stopBufferATR.toFixed(2).padEnd(8)} ${r.minBreakoutATR.toFixed(2).padEnd(10)} ${String(r.maxHoldBars).padEnd(8)} ${ret.padStart(7)}%  ${String(r.winRate).padEnd(7)}  ${String(r.profitFactor).padEnd(6)} ${String(r.maxDD).padEnd(7)} ${String(r.sharpe).padEnd(7)} ${r.trades}`
    );
  }

  const best = results[0];
  console.log(`\n── Best configuration ────────────────────────────────────\n`);
  console.log(`  rrMult:         ${best.rrMult}`);
  console.log(`  stopBufferATR:  ${best.stopBufferATR}`);
  console.log(`  minBreakoutATR: ${best.minBreakoutATR}`);
  console.log(`  maxHoldBars:    ${best.maxHoldBars}`);
  console.log(`  → Return: ${((best.portfolio - 1000) / 1000 * 100).toFixed(1)}%  Sharpe: ${best.sharpe}  MaxDD: ${best.maxDD}%  Trades: ${best.trades}`);
  console.log("\n═══════════════════════════════════════════════════════════\n");
}

export { attachPrevDayLevels, runBacktest, calcATRSeries };
