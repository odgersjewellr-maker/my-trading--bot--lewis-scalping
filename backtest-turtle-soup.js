/**
 * Turtle Soup backtest — runs the exact signal/plan logic from turtle-soup.js
 * against historical OHLC data so you can validate the strategy before wiring
 * it to real money.
 *
 * Usage:
 *   node backtest-turtle-soup.js [csv-path]
 *
 * Env knobs (same names bot.js reads, so a backtest matches your live config):
 *   TS_LOOKBACK, TS_MIN_AGE_BARS, TS_STOP_BUFFER, TS_REWARD_RISK,
 *   TS_MAX_HOLD_BARS, TS_ALLOW_LONG, TS_ALLOW_SHORT
 *   RISK_PCT (% of equity risked per trade, default 5), PAPER_FEE_RATE
 *
 * The default CSV is BTC daily — Turtle Soup's classic home. The live bot can
 * run the identical logic on any timeframe (see README / STRATEGY=turtle-soup).
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { turtleSoupSignal, turtleSoupPlan, tsParamsFromEnv } from "./turtle-soup.js";

const csvPath = process.argv.filter((a) => !a.startsWith("--"))[2] || "btc-daily-binance.csv";

const candles = readFileSync(resolve(csvPath), "utf8")
  .trim()
  .split("\n")
  .slice(1) // header
  .map((l) => {
    const [date, open, high, low, close, volume] = l.split(",");
    return {
      date: (date || "").trim(),
      open:  parseFloat(open),
      high:  parseFloat(high),
      low:   parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume),
    };
  })
  .filter((c) => !isNaN(c.close));

const params   = tsParamsFromEnv();
const riskPct  = parseFloat(process.env.RISK_PCT || "5") / 100;
const feeRate  = parseFloat(process.env.PAPER_FEE_RATE || "0.0008");
const START_EQUITY = parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000");

console.log("═══════════════════════════════════════════════════════════");
console.log("  Turtle Soup Backtest");
console.log(`  CSV: ${csvPath}  (${candles.length} bars, ${candles[0]?.date} → ${candles[candles.length - 1]?.date})`);
console.log(`  Params: lookback ${params.lookback} | min age ${params.minPriorAgeBars} | R:R ${params.rewardRisk} | max hold ${params.maxHoldBars} bars`);
console.log(`  Sides: ${params.allowLong ? "long " : ""}${params.allowShort ? "short" : ""} | Risk/trade ${(riskPct * 100).toFixed(1)}% | Fee ${(feeRate * 100).toFixed(2)}%/side`);
console.log("═══════════════════════════════════════════════════════════\n");

let equity = START_EQUITY;
let peakEquity = equity;
let maxDD = 0;
let position = null;      // { side, entry, stop, target, qty, maxHoldBars, barsHeld, entryIdx, sizeUSD }
const trades = [];

// Sizing mirrors bot.js: risk a fixed % of equity, position = risk / stopDist,
// capped at 1× equity notional (spot, no leverage).
function size(entry, stop) {
  const stopDist = Math.abs(entry - stop);
  if (stopDist <= 0) return 0;
  const riskAmount = equity * riskPct;
  const riskQty = riskAmount / stopDist;
  const maxQty = equity / entry;
  return Math.min(riskQty, maxQty);
}

function closeAt(exitPrice, reason, idx) {
  const gross = position.side === "long"
    ? (exitPrice - position.entry) * position.qty
    : (position.entry - exitPrice) * position.qty;
  const fees = (position.entry * position.qty + exitPrice * position.qty) * feeRate;
  const pnl = gross - fees;
  equity += pnl;
  peakEquity = Math.max(peakEquity, equity);
  maxDD = Math.max(maxDD, peakEquity - equity);
  trades.push({
    side: position.side,
    entryDate: candles[position.entryIdx].date,
    exitDate: candles[idx].date,
    entry: position.entry,
    exit: exitPrice,
    barsHeld: position.barsHeld,
    pnl,
    reason,
    equity,
  });
  position = null;
}

for (let i = 0; i < candles.length; i++) {
  const bar = candles[i];

  // ── Manage an open position on this bar (stop → target → time-stop) ──────────
  if (position) {
    position.barsHeld++;
    if (position.side === "long") {
      if (bar.low <= position.stop)          { closeAt(position.stop,   "stop",   i); }
      else if (bar.high >= position.target)  { closeAt(position.target, "target", i); }
    } else {
      if (bar.high >= position.stop)         { closeAt(position.stop,   "stop",   i); }
      else if (bar.low <= position.target)   { closeAt(position.target, "target", i); }
    }
    if (position && position.barsHeld >= position.maxHoldBars) {
      closeAt(bar.close, "time", i); // exit at the close of the max-hold bar
    }
    if (position) continue; // still holding — don't look for a new entry this bar
  }

  // ── Flat: look for a new setup on the just-closed bar ────────────────────────
  const sig = turtleSoupSignal(candles.slice(0, i + 1), params);
  if (!sig.signal) continue;
  const plan = turtleSoupPlan(sig, bar.close, params);
  const qty = size(plan.entry, plan.stop);
  if (qty <= 0) continue;
  position = {
    side: plan.side,
    entry: plan.entry,
    stop: plan.stop,
    target: plan.target,
    qty,
    sizeUSD: qty * plan.entry,
    maxHoldBars: plan.maxHoldBars,
    barsHeld: 0,
    entryIdx: i,
  };
}

// ── Report ─────────────────────────────────────────────────────────────────
const wins = trades.filter((t) => t.pnl > 0);
const losses = trades.filter((t) => t.pnl <= 0);
const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;
const totalPnl = equity - START_EQUITY;

for (const t of trades) {
  const sign = t.pnl >= 0 ? "+" : "";
  console.log(
    `  ${t.entryDate} → ${t.exitDate}  ${t.side.toUpperCase().padEnd(5)} ` +
    `entry $${t.entry.toFixed(2)} exit $${t.exit.toFixed(2)}  ${t.reason.padEnd(6)} ` +
    `${sign}$${t.pnl.toFixed(2)}  (equity $${t.equity.toFixed(2)})`,
  );
}

console.log("\n── Results ──────────────────────────────────────────────");
console.log(`  Trades           : ${trades.length}`);
console.log(`  Win rate         : ${trades.length ? ((wins.length / trades.length) * 100).toFixed(1) : "0"}%  (${wins.length}W / ${losses.length}L)`);
console.log(`  Net P&L          : ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}  (${((totalPnl / START_EQUITY) * 100).toFixed(1)}% on $${START_EQUITY})`);
console.log(`  Final equity     : $${equity.toFixed(2)}`);
console.log(`  Profit factor    : ${pf === Infinity ? "∞" : pf.toFixed(2)}`);
console.log(`  Max drawdown     : $${maxDD.toFixed(2)}  (${((maxDD / peakEquity) * 100).toFixed(1)}%)`);
console.log(`  Exit breakdown   : ${["stop", "target", "time"].map((r) => `${r} ${trades.filter((t) => t.reason === r).length}`).join(" | ")}`);
console.log("═══════════════════════════════════════════════════════════\n");
