/**
 * Daily Range Breakout — "failed breakout" reversal strategy.
 *
 * The idea (from a prior-day-range trading video, ~70%+ win rate reported on
 * SOL/USDT intraday):
 *
 *   1. Take the previous completed day's high and low. That's the box.
 *      The midpoint of the box is just a visual reference line.
 *   2. Wait for a candle to CLOSE outside the box (a "breakout" close beyond
 *      the prior day's high or low). Price can stay outside for any number
 *      of candles — there's no requirement that the very next candle is the
 *      one that reclaims it.
 *   3. The first candle that CLOSES back inside the box, however many bars
 *      later that is, is the signal: that breakout failed / was a liquidity
 *      grab — trade the reversal back into the range.
 *   4. Stop goes just beyond the furthest point price reached during the
 *      whole breakout excursion (not just the first breakout candle's wick —
 *      if it ran for several bars before reclaiming, the stop has to clear
 *      all of that). Exit is either a fixed reward:risk multiple (2:1 by
 *      default) or, optionally, a "let it run" target at the opposite side
 *      of the box.
 *
 * On top of that base pattern, this file adds optional confirmation filters
 * aimed at trading frequency down / win rate up: a minimum breakout size (in
 * ATR), a "decisive reclaim" requirement (close has to push back past the
 * box midpoint, not just barely poke back in), a volume filter, and a
 * 2-pole Super Smoother oscillator (Ehlers) momentum filter — requires the
 * smoothed trend to actually be turning in the trade's direction at the
 * moment of the reclaim, not just the raw close.
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
 * Without --optimize: prints a comparison table of filter combinations, then
 *                      a full trade log for BASE_CFG.
 * With --optimize:    grid-searches rrMult, stopBufferATR, minBreakoutATR,
 *                      maxHoldBars, the two-pole oscillator filter, and exit
 *                      mode — ranks by Sharpe.
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

// Ehlers 2-pole Super Smoother filter (Cycle Analytics for Traders, pg 32).
// A low-lag recursive filter — used here as a momentum/trend oscillator: its
// slope (filt[i] - filt[i-1]) tells you whether the smoothed trend is rising
// or falling, filtered of the high-frequency noise a raw close won't be.
function calc2PoleSuperSmoother(values, period) {
  const n = values.length;
  const out = new Array(n).fill(null);
  const a1 = Math.exp((-1.414 * Math.PI) / period);
  const b1 = 2 * a1 * Math.cos((1.414 * Math.PI) / period);
  const c2 = b1;
  const c3 = -a1 * a1;
  const c1 = 1 - c2 - c3;
  for (let i = 0; i < n; i++) {
    if (i < 2) { out[i] = values[i]; continue; }
    out[i] = c1 * ((values[i] + values[i - 1]) / 2) + c2 * out[i - 1] + c3 * out[i - 2];
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
  const twoPoleArr = cfg.useTwoPoleFilter ? calc2PoleSuperSmoother(candles.map((c) => c.close), cfg.twoPoleCutoff) : null;
  const n = candles.length;

  let portfolio = 1000;
  let position = null; // { side, entry, qty, stop, target, risk, entryIdx, sizeUSD, breakevenDone }
  let breakout = null; // active excursion outside the box: { dir, boxHigh, boxLow, boxMid, extreme, boxKey }
  const usedUp = {};    // one short setup per box, per direction
  const usedDown = {};

  const trades = [];
  const equity = [portfolio];

  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const atr = atrArr[i];

    // ── Manage open position first — check stop/target against this bar's range ──
    if (position) {
      const pos = position;

      // Optional breakeven trail: once price has moved trailBreakevenAtR * risk
      // in our favor, move the stop to entry so the runner can't turn into a loss.
      if (cfg.trailBreakevenAtR > 0 && !pos.breakevenDone) {
        const favorable = pos.side === "short" ? pos.entry - c.low : c.high - pos.entry;
        if (favorable >= pos.risk * cfg.trailBreakevenAtR) {
          pos.stop = pos.entry;
          pos.breakevenDone = true;
        }
      }

      const { side, stop, target } = pos;
      let exitPrice = null, exitType = null;

      const stopHit = side === "short" ? c.high >= stop : c.low <= stop;
      const targetHit = side === "short" ? c.low <= target : c.high >= target;
      if (stopHit) { exitPrice = stop; exitType = pos.breakevenDone && stop === pos.entry ? "breakeven" : "stop"; }   // conservative: stop checked first
      else if (targetHit) { exitPrice = target; exitType = "target"; }

      // Time stop — close at market if neither level hit within maxHoldBars
      if (!exitPrice && cfg.maxHoldBars && i - pos.entryIdx >= cfg.maxHoldBars) {
        exitPrice = c.close;
        exitType = "time";
      }

      if (exitPrice != null) {
        const pnl = side === "short"
          ? (pos.entry - exitPrice) * pos.qty
          : (exitPrice - pos.entry) * pos.qty;
        portfolio += pnl;
        trades.push({ date: c.date, type: exitType, side, entry: pos.entry, exit: exitPrice, pnl, portfolio });
        if (verbose) console.log(`  ${exitType.toUpperCase().padEnd(9)}  ${c.date}  ${side.toUpperCase()} exit $${exitPrice.toFixed(2)}  P&L $${pnl.toFixed(2)}  Portfolio $${portfolio.toFixed(0)}`);
        position = null;
      }
    }

    // ── Track the current breakout excursion (if any) and look for a reclaim ──
    // The box (boxHigh/boxLow/boxMid) is captured by value when the excursion
    // starts and stays fixed while we track it — it doesn't matter whether a
    // calendar day boundary passes before the reclaim happens, since we're
    // watching a specific price level, not "today's" box.
    if (!position) {
      // Give up on an excursion that never reclaims — this is meant to catch a
      // quick failed breakout, not a trend that ran away and "reclaims" months
      // later after a full regime change (which would also blow the stop
      // distance out to something absurd).
      if (breakout && cfg.maxExcursionBars && i - breakout.startIdx > cfg.maxExcursionBars) {
        breakout = null;
      }

      if (breakout) {
        breakout.extreme = breakout.dir === "up" ? Math.max(breakout.extreme, c.high) : Math.min(breakout.extreme, c.low);

        const reclaimed = breakout.dir === "up" ? c.close <= breakout.boxHigh : c.close >= breakout.boxLow;
        if (reclaimed) {
          const side = breakout.dir === "up" ? "short" : "long";
          const dedup = side === "short" ? usedUp : usedDown;

          const breakoutExt = breakout.dir === "up" ? breakout.extreme - breakout.boxHigh : breakout.boxLow - breakout.extreme;
          const minExt = cfg.minBreakoutATR && atr ? cfg.minBreakoutATR * atr : 0;

          const decisiveOk = !cfg.requireDecisiveClose || (side === "short"
            ? c.close <= breakout.boxHigh - (breakout.boxHigh - breakout.boxMid) * cfg.decisiveFrac
            : c.close >= breakout.boxLow + (breakout.boxMid - breakout.boxLow) * cfg.decisiveFrac);

          const volOk = !cfg.useVolumeFilter || (volSMAArr[i] != null && c.volume >= volSMAArr[i] * cfg.volumeMult);

          let oscOk = true;
          if (cfg.useTwoPoleFilter) {
            if (i < 2) {
              oscOk = false; // not enough history to trust the filter yet
            } else {
              const slope = twoPoleArr[i] - twoPoleArr[i - 1];
              const prevSlope = twoPoleArr[i - 1] - twoPoleArr[i - 2];
              oscOk = side === "short"
                ? (cfg.twoPoleFreshTurn ? slope < 0 && prevSlope >= 0 : slope < 0)
                : (cfg.twoPoleFreshTurn ? slope > 0 && prevSlope <= 0 : slope > 0);
            }
          }

          if (breakoutExt >= minExt && decisiveOk && volOk && oscOk && !dedup[breakout.boxKey]) {
            dedup[breakout.boxKey] = true;

            const buffer = atr ? atr * cfg.stopBufferATR : Math.abs(breakout.boxHigh - breakout.boxLow) * 0.02;
            const entry = c.close;
            const stop = side === "short" ? breakout.extreme + buffer : breakout.extreme - buffer;
            const risk = Math.abs(stop - entry);

            const target = cfg.exitMode === "rangeRun"
              ? (side === "short" ? breakout.boxLow : breakout.boxHigh)
              : (side === "short" ? entry - risk * cfg.rrMult : entry + risk * cfg.rrMult);

            // Risk-based sizing: qty such that a full stop-out loses exactly
            // riskPct of the portfolio, regardless of how wide this particular
            // stop distance is (a wide-excursion trade just gets a smaller size).
            const qty = (portfolio * cfg.riskPct) / risk;
            const sizeUSD = qty * entry;
            position = { side, entry, qty, stop, target, risk, entryIdx: i, sizeUSD, breakevenDone: false };
            if (verbose) console.log(`  OPEN       ${c.date}  ${side.toUpperCase()} $${entry.toFixed(2)}  stop $${stop.toFixed(2)}  target $${target.toFixed(2)}  size $${sizeUSD.toFixed(0)}`);
          }

          breakout = null; // excursion resolved — matched or not, don't re-fire on it
        }
      } else {
        const pHigh = prevHigh[i];
        const pLow = prevLow[i];
        const pMid = prevMid[i];
        if (pHigh != null) {
          const boxKey = dayKey(c.date);
          if (c.close > pHigh) breakout = { dir: "up", boxHigh: pHigh, boxLow: pLow, boxMid: pMid, extreme: c.high, boxKey, startIdx: i };
          else if (c.close < pLow) breakout = { dir: "down", boxHigh: pHigh, boxLow: pLow, boxMid: pMid, extreme: c.low, boxKey, startIdx: i };
        }
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
  rrMult: 2,               // 2:1 reward:risk, per the video (used when exitMode is "fixedRR")
  stopBufferATR: 0.1,      // stop = furthest point of the breakout excursion + 0.1 ATR buffer
  minBreakoutATR: 0,       // require the excursion to clear the level by N * ATR (0 = off)
  requireDecisiveClose: false,
  decisiveFrac: 0.15,      // reclaim close must push this far back past the level, toward the midpoint
  useVolumeFilter: false,
  volumeSMA: 20,
  volumeMult: 1.0,
  useTwoPoleFilter: false, // Ehlers 2-pole Super Smoother momentum confirmation
  twoPoleCutoff: 15,
  twoPoleFreshTurn: false, // true = require the smoother to turn exactly on the reclaim bar (stricter)
  exitMode: "fixedRR",     // "fixedRR" | "rangeRun" (runs to the opposite side of the box)
  trailBreakevenAtR: 0,    // 0 = off; e.g. 1 = move stop to breakeven after 1R in favor
  maxHoldBars: 0,          // 0 = no time stop
  maxExcursionBars: 20,    // abandon an excursion that hasn't reclaimed within N bars (0 = never abandon)
  riskPct: 0.01,           // risk 1% of portfolio per trade, sized off the actual stop distance
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
  const rOsc = runBacktest(candles, { ...BASE_CFG, useTwoPoleFilter: true });
  const rOscFresh = runBacktest(candles, { ...BASE_CFG, useTwoPoleFilter: true, twoPoleFreshTurn: true });
  const rStacked = runBacktest(candles, { ...BASE_CFG, requireDecisiveClose: true, useVolumeFilter: true, useTwoPoleFilter: true });
  const rRangeRun = runBacktest(candles, { ...BASE_CFG, exitMode: "rangeRun", trailBreakevenAtR: 1 });
  const rStackedRangeRun = runBacktest(candles, { ...BASE_CFG, requireDecisiveClose: true, useVolumeFilter: true, useTwoPoleFilter: true, exitMode: "rangeRun", trailBreakevenAtR: 1 });

  const fmt = (r, label) => {
    const ret = ((r.portfolio - 1000) / 10).toFixed(1);
    return `  ${label.padEnd(32)} $${r.portfolio.toFixed(0).padStart(8)}  ${(ret + "%").padStart(8)}  ${String(r.trades).padStart(6)}  ${(r.winRate + "%").padStart(7)}  ${String(r.profitFactor).padStart(5)}  ${(r.maxDD + "%").padStart(7)}  ${r.sharpe}`;
  };

  console.log(`  ${"Label".padEnd(32)} ${"Portfolio".padStart(9)}  ${"Return".padStart(8)}  ${"Trades".padStart(6)}  ${"WinRate".padStart(7)}  ${"PF".padStart(5)}  ${"MaxDD".padStart(7)}  Sharpe`);
  console.log("  " + "─".repeat(100));
  console.log(fmt(rBase, "Base (2:1 R:R)"));
  console.log(fmt(rDecisive, "+ decisive reclaim filter"));
  console.log(fmt(rVol, "+ volume filter"));
  console.log(fmt(rOsc, "+ 2-pole oscillator (slope)"));
  console.log(fmt(rOscFresh, "+ 2-pole oscillator (fresh turn)"));
  console.log(fmt(rStacked, "+ decisive + volume + 2-pole"));
  console.log(fmt(rRangeRun, "Base, rangeRun exit + breakeven"));
  console.log(fmt(rStackedRangeRun, "Stacked filters, rangeRun exit"));

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
  const oscModes = ["off", "slope", "freshTurn"];
  const exitModes = ["fixedRR", "rangeRun"];

  const total = rrMults.length * stopBuffers.length * minBreakoutATRs.length * maxHoldBarsArr.length * oscModes.length * exitModes.length;
  let done = 0;

  for (const rrMult of rrMults) {
    for (const stopBufferATR of stopBuffers) {
      for (const minBreakoutATR of minBreakoutATRs) {
        for (const maxHoldBars of maxHoldBarsArr) {
          for (const oscMode of oscModes) {
            for (const exitMode of exitModes) {
              const cfg = {
                ...BASE_CFG, rrMult, stopBufferATR, minBreakoutATR, maxHoldBars, exitMode,
                useTwoPoleFilter: oscMode !== "off",
                twoPoleFreshTurn: oscMode === "freshTurn",
                trailBreakevenAtR: exitMode === "rangeRun" ? 1 : 0,
              };
              const r = runBacktest(candles, cfg);
              results.push({ rrMult, stopBufferATR, minBreakoutATR, maxHoldBars, oscMode, exitMode, ...r });
              done++;
              if (done % 100 === 0) process.stdout.write(`\r  Progress: ${done}/${total}`);
            }
          }
        }
      }
    }
  }

  results.sort((a, b) => parseFloat(b.sharpe) - parseFloat(a.sharpe));

  console.log("\n\n── Top 10 parameter sets (ranked by Sharpe) ─────────────\n");
  console.log("  rrMult  stopBuf  minBrkATR  maxHold  osc        exit      Return%  WinRate  PF    MaxDD%  Sharpe  Trades");
  console.log("  " + "─".repeat(105));
  for (const r of results.slice(0, 10)) {
    const ret = ((r.portfolio - 1000) / 1000 * 100).toFixed(0);
    console.log(
      `  ${r.rrMult.toFixed(1).padEnd(7)} ${r.stopBufferATR.toFixed(2).padEnd(8)} ${r.minBreakoutATR.toFixed(2).padEnd(10)} ${String(r.maxHoldBars).padEnd(8)} ${r.oscMode.padEnd(10)} ${r.exitMode.padEnd(9)} ${ret.padStart(7)}%  ${String(r.winRate).padEnd(7)}  ${String(r.profitFactor).padEnd(6)} ${String(r.maxDD).padEnd(7)} ${String(r.sharpe).padEnd(7)} ${r.trades}`
    );
  }

  const best = results[0];
  console.log(`\n── Best configuration ────────────────────────────────────\n`);
  console.log(`  rrMult:         ${best.rrMult}`);
  console.log(`  stopBufferATR:  ${best.stopBufferATR}`);
  console.log(`  minBreakoutATR: ${best.minBreakoutATR}`);
  console.log(`  maxHoldBars:    ${best.maxHoldBars}`);
  console.log(`  oscillator:     ${best.oscMode}`);
  console.log(`  exitMode:       ${best.exitMode}`);
  console.log(`  → Return: ${((best.portfolio - 1000) / 1000 * 100).toFixed(1)}%  Sharpe: ${best.sharpe}  MaxDD: ${best.maxDD}%  Trades: ${best.trades}`);
  console.log("\n═══════════════════════════════════════════════════════════\n");
}

export { attachPrevDayLevels, calc2PoleSuperSmoother, runBacktest, calcATRSeries };
