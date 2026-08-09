/**
 * Range Band Bounce — trade the range BETWEEN two liquidity bands, not a
 * breakout of them.
 *
 * The idea (from a prior-range trading video, ~70%+ win rate reported on
 * SOL/USDT intraday), reworked per later direction — this is explicitly NOT
 * a breakout-fade anymore. We are not betting on price clearing the range
 * and are not trying to catch a trend continuation; the bands mark where
 * resting liquidity sits just outside the day's normal range, and the trade
 * is the bounce back into the range once that liquidity gets swept:
 *
 *   1. Box = the previous `bandLookback` completed days' highs and lows
 *      (default 2). That gives an UPPER BAND spanning the two prior highs
 *      and a LOWER BAND spanning the two prior lows:
 *        upper band = [min(H1,H2), max(H1,H2)]
 *        lower band = [min(L1,L2), max(L1,L2)]
 *      The RANGE we actually trade — the CENTER — is the zone both days
 *      agree was "inside": [max(L1,L2), min(H1,H2)]. `bandLookback: 1`
 *      collapses each band to a single previous-day line.
 *   2. Visit — price CLOSES past the near edge of a band (above min(H1,H2),
 *      or below max(L1,L2)) — i.e. leaves the range into liquidity
 *      territory. That's not a trade yet. Also supported: a single candle
 *      that WICKS into (or through) the band and closes back inside the
 *      range in the same bar — the sharp, one-bar version of a liquidity
 *      grab, and arguably the cleanest example of the whole idea.
 *   3. Bail, don't fade, on a real breakout — if a subsequent candle CLOSES
 *      past the FAR edge of the band (both prior days' extremes), that's
 *      sustained conviction beyond the range, not a liquidity grab. Stand
 *      aside (`invalidateOnRealBreakout`, on by default) rather than fade it.
 *   4. Reclaim — the first candle that closes back past the near edge, into
 *      the range, while none of the above happened, is the reclaim candle.
 *   5. Don't enter on the reclaim candle itself — wait for `confirmBars`
 *      total candles (2 by default) each closing further in the trade's
 *      direction before pulling the trigger. If the next candle doesn't
 *      continue that way, the setup is scrapped rather than chased.
 *   6. Stop goes just beyond the furthest point price reached while outside
 *      the range, plus an ATR buffer. Exit is either a fixed reward:risk
 *      multiple (2:1 by default) or a "ride the range" target at the near
 *      edge of the OPPOSITE band — trade from one side of the range to the
 *      other — optionally with a breakeven stop trail.
 *
 * There's no "one trade per box" limit — the whole premise is that price
 * bounces between the two bands repeatedly while the range holds, so each
 * fresh visit to a band is its own independent setup.
 *
 * On top of that base pattern, this file adds optional confirmation filters:
 *   - minBreakoutATR / requireDecisiveClose / useVolumeFilter — filter out
 *     marginal breakouts and half-hearted reclaims.
 *   - useRejectionWickFilter — require the candle that set the excursion's
 *     extreme to show a real rejection wick (a long wick beyond its body),
 *     not just a strong-bodied continuation candle. Classic price-action
 *     "this was a liquidity grab, not real demand/supply" tell.
 *   - useTwoPoleFilter — Ehlers' 2-pole Super Smoother momentum oscillator.
 *   - useFisherFilter — Ehlers' Fisher Transform turning-point oscillator.
 *   - useADXFilter — ADX regime filter (fade strategies get run over in a
 *     strongly trending market; block entries above the ADX threshold).
 *   - useSessionFilter — only ENTER during the London/New York session-open
 *     windows (on by default; `sessions`/`sessionWindowHours` configure UTC
 *     start hours and how many hours from each open to trade — default 8h
 *     and 13h UTC, 3-hour windows, i.e. London and NY opens for good early
 *     volatility). Visit-tracking and confirmation still run at all hours —
 *     only the final entry is session-gated, so structure that started
 *     overnight can still be traded the moment a session opens. This is a
 *     no-op on data with no time-of-day component (plain daily bars).
 *
 * periodMode controls what a "day" means for the box: "day" (default, UTC
 * calendar day) or "week" (ISO week) if you'd rather trade a weekly box.
 *
 * Usage: node daily-range-breakout.js [csv-path] [--optimize]
 *
 * Without --optimize: prints a comparison table of filter combinations, then
 *                      a full trade log for BASE_CFG.
 * With --optimize:    grid-searches rrMult, stopBufferATR, minBreakoutATR,
 *                      confirmBars, the filter stack, and exit mode — ranks
 *                      by Sharpe.
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

// Ehlers Fisher Transform — maps price into a near-Gaussian distribution so
// turning points produce sharp, unambiguous peaks instead of the mushy
// extremes a raw oscillator like RSI gives you. Standard formulation from
// Ehlers' "Using the Fisher Transform" (median price, 9-bar default).
// Returns { fisher, trigger } — trigger is fisher lagged by 1 bar, used the
// same way a MACD signal line is: direction = fisher vs trigger.
function calcFisherTransform(candles, period = 9) {
  const n = candles.length;
  const fisher = new Array(n).fill(0);
  const trigger = new Array(n).fill(0);
  let value1 = 0;
  let fish = 0;
  for (let i = 0; i < n; i++) {
    if (i >= period - 1) {
      let maxH = -Infinity, minL = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        const mid = (candles[j].high + candles[j].low) / 2;
        if (mid > maxH) maxH = mid;
        if (mid < minL) minL = mid;
      }
      const mid = (candles[i].high + candles[i].low) / 2;
      const range = maxH - minL;
      const raw = range > 0 ? (mid - minL) / range : 0.5;
      value1 = 0.33 * 2 * (raw - 0.5) + 0.67 * value1;
      value1 = Math.max(-0.999, Math.min(0.999, value1));
      fish = 0.5 * Math.log((1 + value1) / (1 - value1)) + 0.5 * fish;
    }
    trigger[i] = i > 0 ? fisher[i - 1] : fish;
    fisher[i] = fish;
  }
  return { fisher, trigger };
}

// ADX / DMI (Wilder). Used here purely as a regime filter — this strategy
// fades failed breakouts, which is a counter-trend bet, and counter-trend
// bets get run over when the market is genuinely trending hard.
function calcADXSeries(candles, period = 14) {
  const n = candles.length;
  const plusDM = new Array(n).fill(null);
  const minusDM = new Array(n).fill(null);
  const tr = new Array(n).fill(null);

  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  const smTR = new Array(n).fill(null);
  const smPlus = new Array(n).fill(null);
  const smMinus = new Array(n).fill(null);
  let initTR = 0, initPlus = 0, initMinus = 0;
  if (n <= period) return new Array(n).fill(null);
  for (let i = 1; i <= period; i++) { initTR += tr[i]; initPlus += plusDM[i]; initMinus += minusDM[i]; }
  smTR[period] = initTR; smPlus[period] = initPlus; smMinus[period] = initMinus;
  for (let i = period + 1; i < n; i++) {
    smTR[i] = smTR[i - 1] - smTR[i - 1] / period + tr[i];
    smPlus[i] = smPlus[i - 1] - smPlus[i - 1] / period + plusDM[i];
    smMinus[i] = smMinus[i - 1] - smMinus[i - 1] / period + minusDM[i];
  }

  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (!smTR[i]) continue;
    const plusDI = 100 * smPlus[i] / smTR[i];
    const minusDI = 100 * smMinus[i] / smTR[i];
    const diSum = plusDI + minusDI;
    dx[i] = diSum > 0 ? 100 * Math.abs(plusDI - minusDI) / diSum : 0;
  }

  const adx = new Array(n).fill(null);
  const start = period * 2;
  if (start >= n) return adx;
  let sumDX = 0;
  for (let i = period; i < start; i++) sumDX += dx[i] ?? 0;
  adx[start - 1] = sumDX / period;
  for (let i = start; i < n; i++) adx[i] = (adx[i - 1] * (period - 1) + (dx[i] ?? 0)) / period;
  return adx;
}

// How much of this candle's range is a wick beyond its body, on the given
// side ("up" = upper wick, "down" = lower wick). 0 = no wick (marubozu-ish
// continuation candle), close to 1 = almost the whole bar was rejection.
function wickRejectionRatio(candle, side) {
  const range = candle.high - candle.low;
  if (range <= 0) return 0;
  if (side === "up") {
    const bodyTop = Math.max(candle.open, candle.close);
    return (candle.high - bodyTop) / range;
  }
  const bodyBottom = Math.min(candle.open, candle.close);
  return (bodyBottom - candle.low) / range;
}

// UTC calendar-day key from either "YYYY-MM-DD" or a full ISO timestamp.
function dayKey(dateStr) {
  return dateStr.slice(0, 10);
}

// UTC hour-of-day from a full ISO timestamp ("YYYY-MM-DDTHH:mm:ss"), read by
// string slicing rather than `new Date(...)` — a timestamp without a "Z" or
// offset suffix (which is exactly what fetch-binance-intraday.js writes) is
// parsed as LOCAL time by the Date constructor, which would silently shift
// every hour by whatever timezone this happens to run in. Returns null for
// plain "YYYY-MM-DD" dates with no time component (can't session-filter those).
function utcHour(dateStr) {
  return dateStr.length >= 13 ? parseInt(dateStr.slice(11, 13), 10) : null;
}

// True if this timestamp's UTC hour falls inside any of the given session
// windows (each { startHourUTC, windowHours }). No time component (daily
// bars) always passes — there's nothing to filter.
function inSessionWindow(dateStr, sessions, windowHours) {
  const hour = utcHour(dateStr);
  if (hour == null) return true;
  return sessions.some((start) => {
    const end = start + windowHours;
    return end <= 24 ? hour >= start && hour < end : hour >= start || hour < end - 24;
  });
}

// ISO-8601 week key ("2024-W17"), Monday-start weeks.
function isoWeekKey(dateStr) {
  const base = dateStr.length > 10 ? dateStr : `${dateStr}T00:00:00Z`;
  const raw = new Date(base);
  const date = new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), raw.getUTCDate()));
  const dayNum = date.getUTCDay() || 7; // Sunday -> 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum); // shift to this ISO week's Thursday
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function periodKey(dateStr, mode) {
  return mode === "week" ? isoWeekKey(dateStr) : dayKey(dateStr);
}

// For each candle: the band formed by the last `lookback` COMPLETED periods'
// highs/lows, held fixed for every candle inside the current period.
//   outerHigh = max of those highs   (breakout level, upside)
//   innerHigh = min of those highs   (reclaim level, upside — near edge of the band)
//   outerLow  = min of those lows    (breakout level, downside)
//   innerLow  = max of those lows    (reclaim level, downside — near edge of the band)
// With lookback=1, outerHigh===innerHigh and outerLow===innerLow — a single
// line on each side, same as the original single-day version.
function attachBandLevels(candles, mode, lookback) {
  const n = candles.length;
  const outerHigh = new Array(n).fill(null);
  const innerHigh = new Array(n).fill(null);
  const outerLow = new Array(n).fill(null);
  const innerLow = new Array(n).fill(null);

  let curKey = null, curHigh = -Infinity, curLow = Infinity;
  const completed = []; // rolling buffer of the last `lookback` periods' {high, low}

  for (let i = 0; i < n; i++) {
    const key = periodKey(candles[i].date, mode);
    if (key !== curKey) {
      if (curKey !== null) {
        completed.push({ high: curHigh, low: curLow });
        if (completed.length > lookback) completed.shift();
      }
      curKey = key;
      curHigh = -Infinity;
      curLow = Infinity;
    }
    if (completed.length >= lookback) {
      let oh = -Infinity, ih = Infinity, ol = Infinity, il = -Infinity;
      for (const p of completed) {
        if (p.high > oh) oh = p.high;
        if (p.high < ih) ih = p.high;
        if (p.low < ol) ol = p.low;
        if (p.low > il) il = p.low;
      }
      outerHigh[i] = oh; innerHigh[i] = ih; outerLow[i] = ol; innerLow[i] = il;
    }
    curHigh = Math.max(curHigh, candles[i].high);
    curLow = Math.min(curLow, candles[i].low);
  }
  return { outerHigh, innerHigh, outerLow, innerLow };
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

function runBacktest(candles, cfg, verbose = false) {
  const { outerHigh, innerHigh, outerLow, innerLow } = attachBandLevels(candles, cfg.periodMode, cfg.bandLookback);
  const atrArr = calcATRSeries(candles, cfg.atrLen);
  const volSMAArr = cfg.useVolumeFilter ? calcVolumeSMASeries(candles, cfg.volumeSMA) : null;
  const twoPoleArr = cfg.useTwoPoleFilter ? calc2PoleSuperSmoother(candles.map((c) => c.close), cfg.twoPoleCutoff) : null;
  const fisherArr = cfg.useFisherFilter ? calcFisherTransform(candles, cfg.fisherPeriod) : null;
  const adxArr = cfg.useADXFilter ? calcADXSeries(candles, cfg.adxPeriod) : null;
  const n = candles.length;

  let portfolio = 1000;
  let position = null; // { side, entry, qty, stop, target, risk, entryIdx, sizeUSD, breakevenDone }
  let breakout = null; // active excursion: { dir, outerHigh, innerHigh, outerLow, innerLow, mid, extreme, extremeBar, boxKey, startIdx }
  let pending = null;  // reclaimed, waiting for confirmBars direction confirmation (same shape + side, lastClose, barsConfirmed)

  const trades = [];
  const equity = [portfolio];

  const tryEnter = (i, side, box) => {
    const c = candles[i];
    const atr = atrArr[i];

    // How far into (or through) the band this excursion reached, measured
    // from the near edge — the boundary that actually defines "left the
    // range." Always >= 0 by construction.
    const breakoutExt = side === "short" ? box.extreme - box.innerHigh : box.innerLow - box.extreme;
    const minExt = cfg.minBreakoutATR && atr ? cfg.minBreakoutATR * atr : 0;

    const decisiveOk = !cfg.requireDecisiveClose || (side === "short"
      ? c.close <= box.innerHigh - (box.innerHigh - box.mid) * cfg.decisiveFrac
      : c.close >= box.innerLow + (box.mid - box.innerLow) * cfg.decisiveFrac);

    const volOk = !cfg.useVolumeFilter || (volSMAArr[i] != null && c.volume >= volSMAArr[i] * cfg.volumeMult);

    const rejectionOk = !cfg.useRejectionWickFilter || (box.extremeBar &&
      wickRejectionRatio(box.extremeBar, side === "short" ? "up" : "down") >= cfg.rejectionWickFrac);

    let oscOk = true;
    if (cfg.useTwoPoleFilter) {
      if (i < 2) oscOk = false;
      else {
        const slope = twoPoleArr[i] - twoPoleArr[i - 1];
        const prevSlope = twoPoleArr[i - 1] - twoPoleArr[i - 2];
        oscOk = side === "short"
          ? (cfg.twoPoleFreshTurn ? slope < 0 && prevSlope >= 0 : slope < 0)
          : (cfg.twoPoleFreshTurn ? slope > 0 && prevSlope <= 0 : slope > 0);
      }
    }

    let fisherOk = true;
    if (cfg.useFisherFilter) {
      if (i < cfg.fisherPeriod) fisherOk = false;
      else {
        const f = fisherArr.fisher[i], t = fisherArr.trigger[i];
        const fPrev = fisherArr.fisher[i - 1], tPrev = fisherArr.trigger[i - 1];
        fisherOk = side === "short"
          ? (cfg.fisherFreshCross ? f < t && fPrev >= tPrev : f < t)
          : (cfg.fisherFreshCross ? f > t && fPrev <= tPrev : f > t);
      }
    }

    let regimeOk = true;
    if (cfg.useADXFilter) {
      const adxVal = adxArr[i];
      regimeOk = adxVal == null || adxVal <= cfg.adxMaxThreshold;
    }

    const sessionOk = !cfg.useSessionFilter || inSessionWindow(c.date, cfg.sessions, cfg.sessionWindowHours);

    if (breakoutExt >= minExt && decisiveOk && volOk && rejectionOk && oscOk && fisherOk && regimeOk && sessionOk) {
      const buffer = atr ? atr * cfg.stopBufferATR : Math.abs(box.outerHigh - box.outerLow) * 0.02;
      const entry = c.close;
      const stop = side === "short" ? box.extreme + buffer : box.extreme - buffer;
      const risk = Math.abs(stop - entry);

      // "Opposite side" target = the near edge of the opposite band (the
      // equivalent of the single reference line in the original design).
      const target = cfg.exitMode === "rangeRun"
        ? (side === "short" ? box.innerLow : box.innerHigh)
        : (side === "short" ? entry - risk * cfg.rrMult : entry + risk * cfg.rrMult);

      // Two sizing modes:
      //   "risk"     (default) — qty such that a full stop-out loses exactly
      //              riskPct of the portfolio, regardless of stop distance.
      //   "notional" — qty such that the POSITION VALUE is notionalPct of the
      //              portfolio; the actual $ risked on a stop-out then varies
      //              trade to trade with how wide that trade's stop distance
      //              happens to be (stopDistance/entry fraction of notionalPct).
      //              This is a materially different, much less predictable
      //              risk model than "risk" — see docs before using it.
      const qty = cfg.sizingMode === "notional"
        ? (portfolio * cfg.notionalPct) / entry
        : (portfolio * cfg.riskPct) / risk;
      const sizeUSD = qty * entry;
      position = { side, entry, qty, stop, target, risk, entryIdx: i, sizeUSD, breakevenDone: false };
      if (verbose) console.log(`  OPEN       ${c.date}  ${side.toUpperCase()} $${entry.toFixed(2)}  stop $${stop.toFixed(2)}  target $${target.toFixed(2)}  size $${sizeUSD.toFixed(0)}`);
    }
  };

  for (let i = 1; i < n; i++) {
    const c = candles[i];

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

    if (!position) {
      // ── Phase 1: waiting for direction confirmation after a reclaim ──
      if (pending) {
        const confirmedThisBar = pending.side === "short" ? c.close < pending.lastClose : c.close > pending.lastClose;
        if (confirmedThisBar) {
          pending.lastClose = c.close;
          pending.barsConfirmed++;
          if (pending.barsConfirmed >= cfg.confirmBars) {
            tryEnter(i, pending.side, pending);
            pending = null;
          }
        } else {
          pending = null; // didn't continue in our favor — scrap it, don't chase
        }
      }

      // ── Phase 2: track price visiting a band (liquidity zone), or start a
      // fresh visit. We're not betting on a real breakout — the bands are
      // where resting liquidity sits outside the range, and price dipping
      // into one and coming back is the trade. The far (outer) edge is only
      // used to bail: a CLOSE beyond it means this wasn't a liquidity grab,
      // it's an actual break of the range, and we stand aside rather than
      // fade it. Band levels are captured by value when a visit starts and
      // stay fixed while tracked.
      if (!position && !pending) {
        if (breakout && cfg.maxExcursionBars && i - breakout.startIdx > cfg.maxExcursionBars) {
          breakout = null; // gave up waiting for it to bounce back
        }

        if (breakout) {
          if (breakout.dir === "up" ? c.high > breakout.extreme : c.low < breakout.extreme) {
            breakout.extreme = breakout.dir === "up" ? c.high : c.low;
            breakout.extremeBar = c;
          }

          const brokeRange = cfg.invalidateOnRealBreakout && (breakout.dir === "up" ? c.close > breakout.outerHigh : c.close < breakout.outerLow);
          const reclaimed = !brokeRange && (breakout.dir === "up" ? c.close <= breakout.innerHigh : c.close >= breakout.innerLow);

          if (brokeRange) {
            breakout = null; // sustained close past both prior highs/lows — a real breakout, not a fade
          } else if (reclaimed) {
            const side = breakout.dir === "up" ? "short" : "long";
            if (cfg.confirmBars <= 1) {
              tryEnter(i, side, breakout);
            } else {
              pending = { ...breakout, side, lastClose: c.close, barsConfirmed: 1 };
            }
            breakout = null; // visit resolved either way — don't re-fire on it
          }
        } else {
          const oHigh = outerHigh[i], iHigh = innerHigh[i], oLow = outerLow[i], iLow = innerLow[i];
          // Guard against a degenerate/inverted band (e.g. after a huge gap,
          // where the two days' ranges don't overlap and iLow >= iHigh) —
          // there's no valid "center" to reclaim into, so skip this bar.
          if (oHigh != null && iLow < iHigh) {
            const boxKey = periodKey(c.date, cfg.periodMode);
            const mid = (iHigh + iLow) / 2;
            const baseBox = { outerHigh: oHigh, innerHigh: iHigh, outerLow: oLow, innerLow: iLow, mid, boxKey };

            // Single-candle liquidity grab: wicks into (or through) the band
            // and closes back inside the range, all in one bar — the sharp
            // "bounce off liquidity" this is meant to catch. Checked before
            // the slower multi-bar case since it's the more specific match.
            if (c.high > iHigh && c.close <= iHigh) {
              const box = { dir: "up", ...baseBox, extreme: c.high, extremeBar: c, startIdx: i };
              if (cfg.confirmBars <= 1) tryEnter(i, "short", box);
              else pending = { ...box, side: "short", lastClose: c.close, barsConfirmed: 1 };
            } else if (c.low < iLow && c.close >= iLow) {
              const box = { dir: "down", ...baseBox, extreme: c.low, extremeBar: c, startIdx: i };
              if (cfg.confirmBars <= 1) tryEnter(i, "long", box);
              else pending = { ...box, side: "long", lastClose: c.close, barsConfirmed: 1 };
            } else if (c.close > iHigh) {
              breakout = { dir: "up", ...baseBox, extreme: c.high, extremeBar: c, startIdx: i };
            } else if (c.close < iLow) {
              breakout = { dir: "down", ...baseBox, extreme: c.low, extremeBar: c, startIdx: i };
            }
          }
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
  periodMode: "day",       // "day" (default — back to daily range) | "week"
  bandLookback: 2,         // band = last N days' highs/lows (1 = single line, original behavior)
  confirmBars: 2,          // wait for this many bars closing further in our favor after the reclaim before entering
  rrMult: 2,               // 2:1 reward:risk (used when exitMode is "fixedRR")
  stopBufferATR: 0.1,      // stop = furthest point of the breakout excursion + 0.1 ATR buffer
  minBreakoutATR: 0,       // require the excursion to clear the level by N * ATR (0 = off)
  requireDecisiveClose: false,
  decisiveFrac: 0.15,      // reclaim close must push this far back past the level, toward the midpoint
  useVolumeFilter: false,
  volumeSMA: 20,
  volumeMult: 1.0,
  useRejectionWickFilter: false, // require the excursion's extreme candle to show a real rejection wick
  rejectionWickFrac: 0.3,
  useTwoPoleFilter: false, // Ehlers 2-pole Super Smoother momentum confirmation
  twoPoleCutoff: 15,
  twoPoleFreshTurn: false, // true = require the smoother to turn exactly on the entry bar (stricter)
  useFisherFilter: false,  // Ehlers Fisher Transform turning-point confirmation
  fisherPeriod: 9,
  fisherFreshCross: false, // true = require the fisher/trigger cross to happen exactly on the entry bar
  useADXFilter: false,     // block entries while ADX shows a strongly trending (non-range-bound) market
  adxPeriod: 14,
  adxMaxThreshold: 30,
  invalidateOnRealBreakout: true, // stand aside (don't fade) if price closes past the band's FAR edge
  useSessionFilter: true,  // only ENTER during session windows below (visits/confirmation still track at all hours)
  sessions: [8, 13],       // UTC hours: London open (~8 UTC / 8am GMT), New York open (~13 UTC / 8am EST)
  sessionWindowHours: 3,   // trade for this many hours from each session open — a no-op on daily-bar data (no hour info)
  exitMode: "fixedRR",     // "fixedRR" | "rangeRun" (runs to the near edge of the opposite band)
  trailBreakevenAtR: 0,    // 0 = off; e.g. 1 = move stop to breakeven after 1R in favor
  maxHoldBars: 0,          // 0 = no time stop
  maxExcursionBars: 20,    // abandon a visit that hasn't bounced back within N bars (0 = never abandon)
  sizingMode: "risk",      // "risk" (default) | "notional" — see the note above tryEnter's qty calc
  riskPct: 0.01,           // risk 1% of portfolio per trade, sized off the actual stop distance ("risk" mode)
  notionalPct: 0.25,       // position value = this fraction of portfolio ("notional" mode) — actual $ risk varies per trade
};

if (!OPTIMIZE) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Range Band Bounce Backtest");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Candles: ${candles.length} bars  |  ${candles[0].date} → ${candles[candles.length - 1].date}`);
  console.log(`  periodMode: ${BASE_CFG.periodMode}  |  bandLookback: ${BASE_CFG.bandLookback}  |  confirmBars: ${BASE_CFG.confirmBars}`);
  console.log(`  Note: this is daily-bar data, so with periodMode "day" each period`);
  console.log(`  is exactly one candle — a coarse proxy. Feed intraday (5m/15m)`);
  console.log(`  candles for the real version. See docs for details.\n`);

  const rBase = runBacktest(candles, BASE_CFG);
  const rNoSession = runBacktest(candles, { ...BASE_CFG, useSessionFilter: false });
  const rSingleLine = runBacktest(candles, { ...BASE_CFG, bandLookback: 1 });
  const rNoConfirm = runBacktest(candles, { ...BASE_CFG, confirmBars: 1 });
  const rAllowRealBreakout = runBacktest(candles, { ...BASE_CFG, invalidateOnRealBreakout: false });
  const rWick = runBacktest(candles, { ...BASE_CFG, useRejectionWickFilter: true });
  const rADX = runBacktest(candles, { ...BASE_CFG, useADXFilter: true });
  const rFisher = runBacktest(candles, { ...BASE_CFG, useFisherFilter: true });
  const rStacked = runBacktest(candles, { ...BASE_CFG, useADXFilter: true, useFisherFilter: true, useRejectionWickFilter: true });
  const rStackedRangeRun = runBacktest(candles, { ...BASE_CFG, useADXFilter: true, useFisherFilter: true, useRejectionWickFilter: true, exitMode: "rangeRun", trailBreakevenAtR: 1 });

  const fmt = (r, label) => {
    const ret = ((r.portfolio - 1000) / 10).toFixed(1);
    return `  ${label.padEnd(34)} $${r.portfolio.toFixed(0).padStart(8)}  ${(ret + "%").padStart(8)}  ${String(r.trades).padStart(6)}  ${(r.winRate + "%").padStart(7)}  ${String(r.profitFactor).padStart(5)}  ${(r.maxDD + "%").padStart(7)}  ${r.sharpe}`;
  };

  console.log(`  ${"Label".padEnd(34)} ${"Portfolio".padStart(9)}  ${"Return".padStart(8)}  ${"Trades".padStart(6)}  ${"WinRate".padStart(7)}  ${"PF".padStart(5)}  ${"MaxDD".padStart(7)}  Sharpe`);
  console.log("  " + "─".repeat(102));
  console.log(fmt(rBase, "Base (2-day band, London+NY session)"));
  console.log(fmt(rNoSession, "useSessionFilter=false (no-op here)"));
  console.log(fmt(rSingleLine, "bandLookback=1 (single line)"));
  console.log(fmt(rNoConfirm, "confirmBars=1 (no confirmation)"));
  console.log(fmt(rAllowRealBreakout, "don't bail on real breakouts"));
  console.log(fmt(rWick, "+ rejection wick filter"));
  console.log(fmt(rADX, "+ ADX regime filter"));
  console.log(fmt(rFisher, "+ Fisher Transform filter"));
  console.log(fmt(rStacked, "+ ADX + Fisher + wick stacked"));
  console.log(fmt(rStackedRangeRun, "Stacked filters, rangeRun exit"));

  console.log("\n── Base config — full trade log ─────────────────────────\n");
  runBacktest(candles, BASE_CFG, true);
  console.log("\n═══════════════════════════════════════════════════════════\n");
}

// ─── Grid optimisation ────────────────────────────────────────────────────────

if (OPTIMIZE) {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Range Band Bounce — Grid Search");
  console.log("═══════════════════════════════════════════════════════════\n");

  const results = [];
  const rrMults = [1.5, 2, 2.5, 3];
  const stopBuffers = [0, 0.1, 0.25, 0.5];
  const bandLookbacks = [1, 2, 3];
  const confirmBarsArr = [1, 2, 3];
  const filterStacks = ["none", "adx", "fisher", "wick", "all"];
  const exitModes = ["fixedRR", "rangeRun"];

  const stackCfg = (stack) => ({
    useADXFilter: stack === "adx" || stack === "all",
    useFisherFilter: stack === "fisher" || stack === "all",
    useRejectionWickFilter: stack === "wick" || stack === "all",
  });

  const total = rrMults.length * stopBuffers.length * bandLookbacks.length * confirmBarsArr.length * filterStacks.length * exitModes.length;
  let done = 0;

  for (const rrMult of rrMults) {
    for (const stopBufferATR of stopBuffers) {
      for (const bandLookback of bandLookbacks) {
        for (const confirmBars of confirmBarsArr) {
          for (const stack of filterStacks) {
            for (const exitMode of exitModes) {
              const cfg = {
                ...BASE_CFG, rrMult, stopBufferATR, bandLookback, confirmBars, exitMode,
                ...stackCfg(stack),
                trailBreakevenAtR: exitMode === "rangeRun" ? 1 : 0,
              };
              const r = runBacktest(candles, cfg);
              results.push({ rrMult, stopBufferATR, bandLookback, confirmBars, stack, exitMode, ...r });
              done++;
              if (done % 200 === 0) process.stdout.write(`\r  Progress: ${done}/${total}`);
            }
          }
        }
      }
    }
  }

  results.sort((a, b) => parseFloat(b.sharpe) - parseFloat(a.sharpe));

  console.log("\n\n── Top 10 parameter sets (ranked by Sharpe) ─────────────\n");
  console.log("  rrMult  stopBuf  band  confirm  filters  exit      Return%  WinRate  PF    MaxDD%  Sharpe  Trades");
  console.log("  " + "─".repeat(103));
  for (const r of results.slice(0, 10)) {
    const ret = ((r.portfolio - 1000) / 1000 * 100).toFixed(0);
    console.log(
      `  ${r.rrMult.toFixed(1).padEnd(7)} ${r.stopBufferATR.toFixed(2).padEnd(8)} ${String(r.bandLookback).padEnd(5)} ${String(r.confirmBars).padEnd(8)} ${r.stack.padEnd(8)} ${r.exitMode.padEnd(9)} ${ret.padStart(7)}%  ${String(r.winRate).padEnd(7)}  ${String(r.profitFactor).padEnd(6)} ${String(r.maxDD).padEnd(7)} ${String(r.sharpe).padEnd(7)} ${r.trades}`
    );
  }

  const best = results[0];
  console.log(`\n── Best configuration ────────────────────────────────────\n`);
  console.log(`  rrMult:         ${best.rrMult}`);
  console.log(`  stopBufferATR:  ${best.stopBufferATR}`);
  console.log(`  bandLookback:   ${best.bandLookback}`);
  console.log(`  confirmBars:    ${best.confirmBars}`);
  console.log(`  filters:        ${best.stack}`);
  console.log(`  exitMode:       ${best.exitMode}`);
  console.log(`  → Return: ${((best.portfolio - 1000) / 1000 * 100).toFixed(1)}%  Sharpe: ${best.sharpe}  MaxDD: ${best.maxDD}%  Trades: ${best.trades}`);
  console.log("\n═══════════════════════════════════════════════════════════\n");
}

export { attachBandLevels, calc2PoleSuperSmoother, calcFisherTransform, calcADXSeries, wickRejectionRatio, inSessionWindow, runBacktest, calcATRSeries };
