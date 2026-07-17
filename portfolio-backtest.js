/**
 * portfolio-backtest.js — run the pattern rules across several symbols on ONE
 * shared account, the way a prop account would trade it.
 *
 * Each symbol runs its own signal stream (one position per symbol at a time);
 * every trade is sized as `fraction` of current account equity. Compounded
 * equity is stepped daily so concurrent positions and clustered losses show
 * up in the combined drawdown — the number a prop firm's limit actually hits.
 *
 * Usage: node portfolio-backtest.js [fraction] [csv...]
 *   node portfolio-backtest.js 0.33 btc-daily-binance.csv sol-daily-bitget.csv eth-daily-bitget.csv
 */

import { readFileSync } from "fs";
import { backtest } from "./pattern-backtest.js";

const args = process.argv.slice(2);
const fraction = args.length && !isNaN(parseFloat(args[0])) ? parseFloat(args[0]) : 1 / 3;
const files = args.filter((a) => a.endsWith(".csv"));
const csvs = files.length ? files : ["btc-daily-binance.csv", "sol-daily-bitget.csv", "eth-daily-bitget.csv"];

const config = JSON.parse(readFileSync("pattern-rules.json", "utf8"));
const load = (f) => readFileSync(f, "utf8").trim().split("\n").slice(1).map((l) => {
  const [date, open, high, low, close, volume] = l.split(",");
  return { date, open: +open, high: +high, low: +low, close: +close, volume: +volume };
});

// gather every symbol's trades, tagged with symbol and dates
let allTrades = [];
for (const f of csvs) {
  const sym = f.replace(/-daily.*\.csv$/, "").toUpperCase();
  for (const t of backtest(load(f), config)) allTrades.push({ ...t, sym });
}

// daily equity walk: PnL applied on each trade's exit date, exposure counted
// while the trade is open
const dates = [...new Set(allTrades.flatMap((t) => [t.entryDate, t.exitDate]))].sort();
const byExit = {};
for (const t of allTrades) (byExit[t.exitDate] ??= []).push(t);

let equity = 1, peak = 1, maxDD = 0, ddDate = "";
const years = {};
let open = 0, maxConcurrent = 0;
const opensByDate = {}, closesByDate = {};
for (const t of allTrades) {
  (opensByDate[t.entryDate] ??= []).push(t);
  (closesByDate[t.exitDate] ??= []).push(t);
}
for (const d of dates) {
  open += (opensByDate[d]?.length ?? 0);
  for (const t of byExit[d] ?? []) {
    equity *= 1 + (t.netPct / 100) * fraction;
    years[d.slice(0, 4)] = (years[d.slice(0, 4)] ?? 1) * (1 + (t.netPct / 100) * fraction);
  }
  open -= (closesByDate[d]?.length ?? 0);
  maxConcurrent = Math.max(maxConcurrent, open);
  peak = Math.max(peak, equity);
  const dd = (peak - equity) / peak;
  if (dd > maxDD) { maxDD = dd; ddDate = d; }
}

const span = (new Date(dates[dates.length - 1]) - new Date(dates[0])) / (365.25 * 24 * 3600 * 1000);
const wins = allTrades.filter((t) => t.netPct > 0).length;
const gw = allTrades.filter((t) => t.netPct > 0).reduce((s, t) => s + t.netPct, 0);
const gl = allTrades.filter((t) => t.netPct <= 0).reduce((s, t) => s - t.netPct, 0);

console.log(`Symbols: ${csvs.join(", ")}`);
console.log(`Sizing: ${(fraction * 100).toFixed(0)}% of equity per trade | period ${dates[0]} -> ${dates[dates.length - 1]}\n`);
console.log(`Trades:          ${allTrades.length} (${(allTrades.length / span).toFixed(1)}/year)`);
console.log(`Win rate:        ${((wins / allTrades.length) * 100).toFixed(1)}%`);
console.log(`Profit factor:   ${(gw / gl).toFixed(2)}`);
console.log(`Max concurrent:  ${maxConcurrent} positions (${(maxConcurrent * fraction * 100).toFixed(0)}% of account deployed)`);
console.log(`Total return:    ${((equity - 1) * 100).toFixed(1)}%`);
console.log(`CAGR:            ${((Math.pow(equity, 1 / span) - 1) * 100).toFixed(1)}%/yr`);
console.log(`Max drawdown:    ${(maxDD * 100).toFixed(1)}% (reached ${ddDate})\n`);
console.log(`Per year (on combined equity):`);
for (const [y, eq] of Object.entries(years).sort()) {
  console.log(`  ${y}: ${((eq - 1) * 100).toFixed(1)}%`);
}
