/**
 * Opening Drive — session-anchored opening-range-breakout day-trading strategy.
 *
 * The idea (uncorrelated to the NKB kernel-band system and the VWAP/RSI scalper):
 *   1. WATCH the pre-open window and note which way price is leaning.
 *   2. Let the first few minutes after "the open" build an OPENING RANGE (OR).
 *   3. Trade the BREAKOUT in the strong direction — the opening drive.
 *   4. Ride it, then EXIT as it FADES (trail / close back inside range / time stop).
 *   5. One trade per day, flat overnight. Pure day trade.
 *
 * Crypto has no bell, so "the open" is configurable. Default = 13:30 UTC
 * (09:30 New York — US equity/ETF/CME flow, the closest thing crypto has to an
 * institutional open). Flip SESSION_OPEN_UTC to "00:00" for the daily-candle open.
 *
 * Usage:
 *   node opening-drive.js <intraday.csv>          full backtest + trade log
 *   node opening-drive.js <intraday.csv> --optimize   grid-search key params
 *   node opening-drive.js --selftest              run the built-in fixture (no data needed)
 *
 * Expected CSV columns (see fetch-binance-intraday.js):
 *   Timestamp,Open,High,Low,Close,Volume     Timestamp = ISO8601 UTC, e.g. 2025-01-02T13:30:00Z
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// ─── Config ─────────────────────────────────────────────────────────────────

const BASE_CFG = {
  sessionOpenUTC:  "13:30", // "the open" (UTC). "13:30" = NY 09:30. "00:00" = daily candle open.
  preOpenMins:     60,      // pre-open watch window length
  orMins:          15,      // opening-range duration after the open
  driveWindowMins: 240,     // how long the drive lasts before we force-flat (morning session)

  requireBiasAgree: true,   // only take the breakout if the pre-open lean agrees ("strong direction")
  minPreDriftPct:   0.0,    // require at least this |pre-open drift| to call a direction (0 = any)

  // Exits — "till it fades"
  stopAtRangeOpposite: true, // initial stop = far side of the opening range
  atrStopMult:      0.0,     // if >0 and range stop disabled, stop = atrStopMult * OR height
  fadeExitOnClose:  true,    // exit if a candle CLOSES back inside the opening range
  useTrail:         true,    // trail the stop to the prior candle's low(long)/high(short)
  targetR:          0.0,     // fixed take-profit in R multiples (0 = disabled, let it run/fade)

  // Sizing / costs
  tradeSizePct:    0.80,     // notional as fraction of portfolio (matches backtest.js)
  feePct:          0.0006,   // taker fee per side (~BitGet)
  weekdaysOnly:    false,    // skip Sat/Sun sessions (US-open flow is a weekday thing)

  startEquity:     1000,
};

// ─── CSV loader ───────────────────────────────────────────────────────────────

function loadCandles(csvPath) {
  const raw = readFileSync(resolve(csvPath), "utf8").trim().split("\n");
  const header = raw[0].split(",").map((h) => h.trim().toLowerCase());
  const iTs   = header.findIndex((h) => h === "timestamp" || h === "time" || h === "date");
  const iOpen = header.indexOf("open");
  const iHigh = header.indexOf("high");
  const iLow  = header.indexOf("low");
  const iClose= header.indexOf("close");
  const iVol  = header.indexOf("volume");
  if (iTs < 0 || iOpen < 0 || iClose < 0) {
    throw new Error("CSV needs at least Timestamp,Open,High,Low,Close columns");
  }

  return raw.slice(1)
    .map((line) => {
      const p = line.split(",");
      const ts = Date.parse(p[iTs].trim());
      return {
        ts,
        open:  parseFloat(p[iOpen]),
        high:  iHigh >= 0 ? parseFloat(p[iHigh]) : parseFloat(p[iClose]),
        low:   iLow  >= 0 ? parseFloat(p[iLow])  : parseFloat(p[iClose]),
        close: parseFloat(p[iClose]),
        volume: iVol >= 0 ? parseFloat(p[iVol]) : 0,
      };
    })
    .filter((c) => !isNaN(c.ts) && !isNaN(c.close))
    .sort((a, b) => a.ts - b.ts);
}

// ─── Session helpers ──────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function parseHHMM(s) {
  const [h, m] = s.split(":").map(Number);
  return (h * 60 + (m || 0)) * 60_000; // ms offset from UTC midnight
}

// Group candles by UTC date string so we can assemble a session cheaply.
function bucketByDate(candles) {
  const map = new Map();
  for (const c of candles) {
    const d = new Date(c.ts).toISOString().slice(0, 10);
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(c);
  }
  return map;
}

// Build the candles that belong to one session (pre-open .. drive end), using
// absolute timestamps so it works even when the open sits near midnight.
function sessionSlice(byDate, dateStr, cfg) {
  const openTs  = Date.parse(dateStr + "T00:00:00Z") + parseHHMM(cfg.sessionOpenUTC);
  const preTs   = openTs - cfg.preOpenMins * 60_000;
  const orEndTs = openTs + cfg.orMins * 60_000;
  const endTs   = openTs + cfg.driveWindowMins * 60_000;

  // Candles can span the previous day (pre-open) — pull both buckets.
  const prevStr = new Date(Date.parse(dateStr + "T00:00:00Z") - DAY_MS).toISOString().slice(0, 10);
  const pool = [...(byDate.get(prevStr) || []), ...(byDate.get(dateStr) || [])];

  const preOpen = pool.filter((c) => c.ts >= preTs   && c.ts < openTs);
  const orBars  = pool.filter((c) => c.ts >= openTs  && c.ts < orEndTs);
  const drive   = pool.filter((c) => c.ts >= orEndTs && c.ts < endTs);
  return { openTs, preOpen, orBars, drive };
}

// ─── Backtest engine ──────────────────────────────────────────────────────────

function runBacktest(candles, cfg, verbose = false) {
  const byDate = bucketByDate(candles);
  const dates  = [...byDate.keys()].sort();

  let portfolio = cfg.startEquity;
  const trades  = [];
  const sessionEquity = [portfolio]; // one mark per session, for Sharpe/DD

  for (const dateStr of dates) {
    if (cfg.weekdaysOnly) {
      const dow = new Date(dateStr + "T00:00:00Z").getUTCDay(); // 0=Sun,6=Sat
      if (dow === 0 || dow === 6) continue;
    }

    const { preOpen, orBars, drive } = sessionSlice(byDate, dateStr, cfg);
    if (orBars.length === 0 || drive.length === 0 || preOpen.length === 0) {
      sessionEquity.push(portfolio);
      continue;
    }

    // 1. Pre-open lean
    const preDrift = (preOpen[preOpen.length - 1].close - preOpen[0].open) / preOpen[0].open;
    const bias = preDrift > 0 ? 1 : preDrift < 0 ? -1 : 0;

    // 2. Opening range
    const orHigh = Math.max(...orBars.map((c) => c.high));
    const orLow  = Math.min(...orBars.map((c) => c.low));
    const orHeight = orHigh - orLow;

    // 3. Find the first breakout in the drive window
    let pos = null; // { side, entry, stop, qty, initialRisk, entryTs }
    let exitInfo = null;

    for (const c of drive) {
      if (!pos) {
        const breakUp   = c.close > orHigh;
        const breakDown = c.close < orLow;
        const biasOK = (dir) => !cfg.requireBiasAgree
          || (Math.abs(preDrift) >= cfg.minPreDriftPct && bias === dir);

        let side = null;
        if (breakUp && biasOK(1))        side = "long";
        else if (breakDown && biasOK(-1)) side = "short";
        if (!side) continue;

        const entry = c.close;
        let stop;
        if (cfg.stopAtRangeOpposite)      stop = side === "long" ? orLow : orHigh;
        else if (cfg.atrStopMult > 0)     stop = side === "long" ? entry - cfg.atrStopMult * orHeight
                                                                  : entry + cfg.atrStopMult * orHeight;
        else                              stop = side === "long" ? entry - orHeight : entry + orHeight;

        const initialRisk = Math.abs(entry - stop);
        if (initialRisk <= 0) continue;
        const notional = portfolio * cfg.tradeSizePct;
        pos = { side, entry, stop, qty: notional / entry, initialRisk, entryTs: c.ts };
        continue; // entered on this candle's close; manage from the next one
      }

      // ── Manage open position on this candle ──
      const dir = pos.side === "long" ? 1 : -1;

      // a) stop (intrabar, conservative — checked before target)
      const stopHit = pos.side === "long" ? c.low <= pos.stop : c.high >= pos.stop;
      if (stopHit) { exitInfo = { price: pos.stop, reason: "stop", ts: c.ts }; break; }

      // b) fixed target in R
      if (cfg.targetR > 0) {
        const tgt = pos.entry + dir * cfg.targetR * pos.initialRisk;
        const tgtHit = pos.side === "long" ? c.high >= tgt : c.low <= tgt;
        if (tgtHit) { exitInfo = { price: tgt, reason: "target", ts: c.ts }; break; }
      }

      // c) fade: candle closes back inside the opening range
      if (cfg.fadeExitOnClose) {
        const faded = pos.side === "long" ? c.close < orHigh : c.close > orLow;
        if (faded) { exitInfo = { price: c.close, reason: "fade", ts: c.ts }; break; }
      }

      // d) trail the stop to the prior candle's extreme (never loosen)
      if (cfg.useTrail) {
        pos.stop = pos.side === "long"
          ? Math.max(pos.stop, c.low)
          : Math.min(pos.stop, c.high);
      }
    }

    // Force-flat at the end of the drive window if still open
    if (pos && !exitInfo) {
      const last = drive[drive.length - 1];
      exitInfo = { price: last.close, reason: "time", ts: last.ts };
    }

    // Book the trade
    if (pos && exitInfo) {
      const dir = pos.side === "long" ? 1 : -1;
      const gross = (exitInfo.price - pos.entry) * pos.qty * dir;
      const fees  = (pos.entry + exitInfo.price) * pos.qty * cfg.feePct;
      const pnl   = gross - fees;
      portfolio  += pnl;
      const rMult = dir * (exitInfo.price - pos.entry) / pos.initialRisk;
      trades.push({
        date: dateStr, side: pos.side, entry: pos.entry, exit: exitInfo.price,
        reason: exitInfo.reason, pnl, rMult, portfolio,
      });
      if (verbose) {
        console.log(`  ${dateStr}  ${pos.side.toUpperCase().padEnd(5)} in $${pos.entry.toFixed(2)} → out $${exitInfo.price.toFixed(2)}  ${exitInfo.reason.padEnd(6)}  R ${rMult.toFixed(2).padStart(6)}  P&L $${pnl.toFixed(2).padStart(9)}  Port $${portfolio.toFixed(0)}`);
      }
    }

    sessionEquity.push(portfolio);
  }

  return { ...stats(trades, sessionEquity, cfg), trades };
}

// ─── Stats ──────────────────────────────────────────────────────────────────

function stats(trades, equity, cfg) {
  const wins   = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const winRate = trades.length ? (wins.length / trades.length * 100) : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const expectancyR = trades.length ? trades.reduce((s, t) => s + t.rMult, 0) / trades.length : 0;

  let peak = equity[0], maxDD = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (peak - v) / peak * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }

  const rets = equity.slice(1).map((v, i) => equity[i] > 0 ? (v - equity[i]) / equity[i] : 0);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd   = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length || 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;

  const finalEq = equity[equity.length - 1];
  return {
    finalEq, totalPnl, nTrades: trades.length,
    winRate: +winRate.toFixed(1),
    profitFactor: profitFactor === Infinity ? Infinity : +profitFactor.toFixed(2),
    expectancyR: +expectancyR.toFixed(3),
    maxDD: +maxDD.toFixed(1),
    sharpe: +sharpe.toFixed(2),
    returnPct: +((finalEq - cfg.startEquity) / cfg.startEquity * 100).toFixed(1),
  };
}

function printReport(title, r) {
  const pf = r.profitFactor === Infinity ? "∞" : r.profitFactor.toFixed(2);
  console.log(`\n  ${title}`);
  console.log("  " + "─".repeat(58));
  console.log(`  Final equity   $${r.finalEq.toFixed(2)}   (${r.returnPct >= 0 ? "+" : ""}${r.returnPct}%)`);
  console.log(`  Trades         ${r.nTrades}`);
  console.log(`  Win rate       ${r.winRate}%`);
  console.log(`  Profit factor  ${pf}`);
  console.log(`  Expectancy     ${r.expectancyR >= 0 ? "+" : ""}${r.expectancyR} R / trade`);
  console.log(`  Max drawdown   ${r.maxDD}%`);
  console.log(`  Sharpe (ann.)  ${r.sharpe}`);
}

// ─── Self-test (deterministic fixture, no data/network needed) ─────────────────

function selftest() {
  // 15-min candles. Self-test config: open 13:30 UTC, preOpen 60m, OR 30m, drive 90m.
  // Six crafted sessions exercise every path: trailing-stop win, initial-stop loss,
  // no-breakout, fade exit, time exit, and bias-rejection. All values traced by hand.
  const rows = [];
  const push = (dt, o, h, l, c) => rows.push({ ts: Date.parse(dt), open: o, high: h, low: l, close: c, volume: 1 });

  // ── Day A: LONG, runs up, reverses into the TRAILING stop → win (reason "stop") ──
  const A = "2025-01-06";
  push(`${A}T12:30:00Z`, 100.0, 100.3,  99.9, 100.2);
  push(`${A}T13:15:00Z`, 100.2, 100.8, 100.1, 100.7); // pre-open drift up → bias long
  push(`${A}T13:30:00Z`, 100.7, 101.0, 100.4, 100.8); // OR bar 1
  push(`${A}T13:45:00Z`, 100.8, 101.2, 100.6, 101.0); // OR bar 2 → OR high 101.2 / low 100.4
  push(`${A}T14:00:00Z`, 101.0, 102.0, 101.0, 101.9); // close>101.2 → LONG @101.9, stop 100.4
  push(`${A}T14:15:00Z`, 101.9, 103.0, 101.8, 102.9); // trail stop → 101.8
  push(`${A}T14:30:00Z`, 102.9, 103.5, 102.8, 103.4); // trail stop → 102.8
  push(`${A}T14:45:00Z`, 103.4, 103.6, 102.5, 102.6); // low 102.5 ≤ trail 102.8 → exit @102.8 (win)

  // ── Day B: LONG, immediate reversal into the INITIAL stop → loss (reason "stop") ──
  const B = "2025-01-07";
  push(`${B}T12:30:00Z`, 200.0, 200.3, 199.9, 200.2);
  push(`${B}T13:15:00Z`, 200.2, 200.8, 200.1, 200.7); // drift up
  push(`${B}T13:30:00Z`, 200.7, 201.0, 200.4, 200.8);
  push(`${B}T13:45:00Z`, 200.8, 201.2, 200.6, 201.0); // OR high 201.2 / low 200.4
  push(`${B}T14:00:00Z`, 201.0, 202.0, 201.0, 201.9); // LONG @201.9, stop 200.4
  push(`${B}T14:15:00Z`, 201.9, 202.0, 200.2, 200.3); // low 200.2 ≤ 200.4 → stop @200.4 (loss)

  // ── Day C: never breaks the opening range → no trade ──
  const C = "2025-01-08";
  push(`${C}T12:30:00Z`, 300.0, 300.3, 299.9, 300.2);
  push(`${C}T13:15:00Z`, 300.2, 300.8, 300.1, 300.7); // drift up
  push(`${C}T13:30:00Z`, 300.7, 301.2, 300.4, 300.9);
  push(`${C}T13:45:00Z`, 300.9, 301.3, 300.6, 301.0); // OR high 301.3 / low 300.4
  push(`${C}T14:00:00Z`, 301.0, 301.2, 300.7, 301.0); // close never > 301.3
  push(`${C}T14:15:00Z`, 301.0, 301.3, 300.8, 301.1);

  // ── Day D: LONG breakout then closes back inside range → FADE exit (reason "fade") ──
  const D = "2025-01-09";
  push(`${D}T12:30:00Z`, 400.0, 400.3, 399.9, 400.2);
  push(`${D}T13:15:00Z`, 400.2, 400.8, 400.1, 400.7); // drift up
  push(`${D}T13:30:00Z`, 400.7, 401.0, 400.4, 400.8);
  push(`${D}T13:45:00Z`, 400.8, 401.2, 400.6, 401.0); // OR high 401.2 / low 400.4
  push(`${D}T14:00:00Z`, 401.0, 401.6, 401.0, 401.5); // LONG @401.5, stop 400.4
  push(`${D}T14:15:00Z`, 401.5, 401.7, 401.3, 401.0); // close 401.0 < OR high 401.2 → fade @401.0

  // ── Day E: LONG breakout holds above range all session → TIME exit (reason "time") ──
  const E = "2025-01-10";
  push(`${E}T12:30:00Z`, 500.0, 500.3, 499.9, 500.2);
  push(`${E}T13:15:00Z`, 500.2, 500.8, 500.1, 500.7); // drift up
  push(`${E}T13:30:00Z`, 500.7, 501.0, 500.4, 500.8);
  push(`${E}T13:45:00Z`, 500.8, 501.2, 500.6, 501.0); // OR high 501.2 / low 500.4
  push(`${E}T14:00:00Z`, 501.0, 501.8, 501.0, 501.7); // LONG @501.7, stop 500.4
  push(`${E}T14:15:00Z`, 501.7, 502.0, 501.6, 501.9); // holds, trail → 501.6
  push(`${E}T14:30:00Z`, 501.9, 502.2, 501.8, 502.1); // holds, trail → 501.8
  push(`${E}T14:45:00Z`, 502.1, 502.5, 502.0, 502.3); // last drive bar → time exit @502.3 (win)

  // ── Day F: pre-open UP but price breaks DOWN → bias filter rejects it (no trade) ──
  const F = "2025-01-13";
  push(`${F}T12:30:00Z`, 600.0, 600.3, 599.9, 600.2);
  push(`${F}T13:15:00Z`, 600.2, 600.8, 600.1, 600.7); // drift up → bias long
  push(`${F}T13:30:00Z`, 600.7, 601.0, 600.2, 600.5);
  push(`${F}T13:45:00Z`, 600.5, 600.8, 600.0, 600.3); // OR high 601.0 / low 600.0
  push(`${F}T14:00:00Z`, 600.3, 600.5, 599.4, 599.5); // breaks DOWN — bias is long → rejected
  push(`${F}T14:15:00Z`, 599.5, 599.8, 599.0, 599.2); // still down, still rejected

  const cfg = { ...BASE_CFG, orMins: 30, driveWindowMins: 90, targetR: 0,
                useTrail: true, fadeExitOnClose: true, tradeSizePct: 0.5, feePct: 0 };
  const r = runBacktest(rows, cfg, true);

  const t = r.trades;
  const byDate = (d) => t.find((x) => x.date === d);
  const checks = [
    ["exactly 4 trades booked (A,B,D,E; C & F none)", t.length === 4],
    ["A: LONG, trailing-stop exit, profitable",       byDate(A)?.side === "long" && byDate(A)?.reason === "stop" && byDate(A)?.pnl > 0],
    ["B: LONG, initial-stop exit, a loss",            byDate(B)?.side === "long" && byDate(B)?.reason === "stop" && byDate(B)?.pnl < 0],
    ["C: no breakout → no trade",                     !byDate(C)],
    ["D: fade exit (closed back inside range)",        byDate(D)?.reason === "fade"],
    ["E: time exit (held to session end), profitable", byDate(E)?.reason === "time" && byDate(E)?.pnl > 0],
    ["F: bias filter rejected the counter move",       !byDate(F)],
  ];

  console.log("\n  Self-test assertions");
  console.log("  " + "─".repeat(58));
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`   ${pass ? "PASS" : "FAIL"}  ${label}`);
    if (!pass) ok = false;
  }
  console.log("\n  " + (ok ? "ALL CHECKS PASSED ✓" : "SELF-TEST FAILED ✗"));
  process.exit(ok ? 0 : 1);
}

// ─── Grid optimisation ─────────────────────────────────────────────────────────

function optimize(candles) {
  console.log("\n══ Opening Drive — grid search ══════════════════════════════\n");
  const grid = [];
  for (const orMins of [15, 30, 60])
    for (const driveWindowMins of [120, 240, 360])
      for (const stopAtRangeOpposite of [true, false])
        for (const requireBiasAgree of [true, false])
          grid.push({ orMins, driveWindowMins, stopAtRangeOpposite, requireBiasAgree });

  const results = grid.map((g) => {
    const cfg = { ...BASE_CFG, ...g, atrStopMult: g.stopAtRangeOpposite ? 0 : 1.0 };
    const r = runBacktest(candles, cfg);
    return { ...g, ...r };
  }).filter((r) => r.nTrades >= 10)
    .sort((a, b) => b.sharpe - a.sharpe);

  console.log("  OR  drive  rangeStop  biasAgree   Ret%   Win%   PF    ExpR    DD%   Sharpe  N");
  console.log("  " + "─".repeat(82));
  for (const r of results.slice(0, 12)) {
    const pf = r.profitFactor === Infinity ? "∞" : r.profitFactor.toFixed(2);
    console.log(
      `  ${String(r.orMins).padEnd(3)} ${String(r.driveWindowMins).padEnd(5)} ` +
      `${String(r.stopAtRangeOpposite).padEnd(9)} ${String(r.requireBiasAgree).padEnd(9)} ` +
      `${String(r.returnPct).padStart(6)} ${String(r.winRate).padStart(5)} ${pf.padStart(5)} ` +
      `${r.expectancyR.toFixed(2).padStart(6)} ${String(r.maxDD).padStart(5)} ${r.sharpe.toFixed(2).padStart(6)}  ${r.nTrades}`
    );
  }
  if (!results.length) console.log("  (no parameter set produced >= 10 trades on this data)");
  console.log("");
}

// ─── Entry point ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes("--selftest")) {
  selftest();
} else {
  const csvPath = args.find((a) => !a.startsWith("--"));
  if (!csvPath) {
    console.error("Usage: node opening-drive.js <intraday.csv> [--optimize]");
    console.error("       node opening-drive.js --selftest");
    console.error("\nNo intraday CSV yet? Run:  node fetch-binance-intraday.js BTCUSDT 15m");
    process.exit(1);
  }
  const candles = loadCandles(csvPath);
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Opening Drive — session-anchored opening-range breakout");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Candles: ${candles.length}  |  ${new Date(candles[0].ts).toISOString()} → ${new Date(candles[candles.length-1].ts).toISOString()}`);
  console.log(`  Open ${BASE_CFG.sessionOpenUTC} UTC | pre-open ${BASE_CFG.preOpenMins}m | OR ${BASE_CFG.orMins}m | drive ${BASE_CFG.driveWindowMins}m`);

  if (args.includes("--optimize")) {
    optimize(candles);
  } else {
    const r = runBacktest(candles, BASE_CFG, false);
    printReport("Result — default config", r);
    console.log("\n── Trade log ────────────────────────────────────────────\n");
    runBacktest(candles, BASE_CFG, true);
    console.log("\n═══════════════════════════════════════════════════════════\n");
  }
}
