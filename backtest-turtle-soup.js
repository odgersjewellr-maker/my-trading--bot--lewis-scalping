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
import { simulateTurtleSoup, tsParamsFromEnv } from "./turtle-soup.js";

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

const { trades, equity, maxDD, stats } = simulateTurtleSoup(candles, params, {
  riskPct, feeRate, startEquity: START_EQUITY,
});
const peakEquity = stats.peak;
const totalPnl = stats.pnl;

for (const t of trades) {
  const sign = t.pnl >= 0 ? "+" : "";
  console.log(
    `  ${candles[t.entryIdx].date} → ${candles[t.exitIdx].date}  ${t.side.toUpperCase().padEnd(5)} ` +
    `entry $${t.entry.toFixed(2)} exit $${t.exit.toFixed(2)}  ${t.reason.padEnd(6)} ` +
    `${sign}$${t.pnl.toFixed(2)}  (equity $${t.equity.toFixed(2)})`,
  );
}

console.log("\n── Results ──────────────────────────────────────────────");
console.log(`  Trades           : ${stats.trades}`);
console.log(`  Win rate         : ${stats.trades ? (stats.winRate * 100).toFixed(1) : "0"}%  (${stats.wins}W / ${stats.losses}L)`);
console.log(`  Net P&L          : ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}  (${((totalPnl / START_EQUITY) * 100).toFixed(1)}% on $${START_EQUITY})`);
console.log(`  Final equity     : $${equity.toFixed(2)}`);
console.log(`  Profit factor    : ${stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2)}`);
console.log(`  Max drawdown     : $${maxDD.toFixed(2)}  (${((maxDD / peakEquity) * 100).toFixed(1)}%)`);
console.log(`  Exit breakdown   : ${["stop", "target", "time"].map((r) => `${r} ${trades.filter((t) => t.reason === r).length}`).join(" | ")}`);
console.log("═══════════════════════════════════════════════════════════\n");
