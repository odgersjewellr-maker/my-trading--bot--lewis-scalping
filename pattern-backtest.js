/**
 * pattern-backtest.js — trades the if-this-then-that rules in
 * pattern-rules.json over historical candles and reports what would have
 * happened, fees included.
 *
 * Usage:
 *   node pattern-backtest.js                        # btc-daily-binance.csv
 *   node pattern-backtest.js my-1h-candles.csv      # any OHLCV CSV
 *
 * Mechanics (kept honest):
 *   - signals are evaluated on CLOSED candles only
 *   - entry at the NEXT candle's open (you can't trade a close you just saw)
 *   - stop-loss checked against each candle's low (gap-through fills at open)
 *   - exit at close after hold_candles, or at stop, whichever comes first
 *   - one position at a time; fees charged per side
 *
 * evaluateRules() is exported so bot.js can reuse the exact same logic live:
 *   const decision = evaluateRules(ctx, candles.length - 1, config);
 */

import { readFileSync } from "fs";
import { buildContext, detectAt, MIN_HISTORY, PATTERNS } from "./patterns.js";

// ── rule engine ──────────────────────────────────────────────────────────────
/** First enabled rule whose conditions all fire (and vetoes don't) at candle i. */
export function evaluateRules(ctx, i, config) {
  if (i < MIN_HISTORY) return null;
  const fired = new Set();
  const f = detectAt(ctx, i);
  for (const ids of Object.values(f)) for (const id of ids) fired.add(id);

  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    const { all = [], none = [], none_recent = null, all_recent = null } = rule.if;
    const unknown = [...all, ...none, ...(none_recent?.patterns ?? []), ...(all_recent?.patterns ?? [])]
      .filter((id) => !PATTERNS[id]);
    if (unknown.length) throw new Error(`Rule "${rule.name}" uses unknown pattern id(s): ${unknown.join(", ")}`);
    if (!all.every((id) => fired.has(id)) || !none.every((id) => !fired.has(id))) continue;
    // none_recent: veto if any listed pattern fired in the `window` candles BEFORE the signal
    if (none_recent) {
      let vetoed = false;
      for (let j = Math.max(0, i - none_recent.window); j < i && !vetoed; j++) {
        for (const id of none_recent.patterns) {
          if (PATTERNS[id].detect(ctx, j)) { vetoed = true; break; }
        }
      }
      if (vetoed) continue;
    }
    // all_recent: require every listed pattern to have fired within the `window`
    // candles before the signal, or on the signal candle itself
    if (all_recent) {
      const ok = all_recent.patterns.every((id) => {
        for (let j = Math.max(0, i - all_recent.window); j <= i; j++) {
          if (j === i ? fired.has(id) : PATTERNS[id].detect(ctx, j)) return true;
        }
        return false;
      });
      if (!ok) continue;
    }
    return { rule: rule.name, ...rule.then, matched: all, vetoedBy: [] };
  }
  return null;
}

// ── backtest ─────────────────────────────────────────────────────────────────
function loadCsv(file) {
  return readFileSync(file, "utf8").trim().split("\n").slice(1).map((l) => {
    const [date, open, high, low, close, volume] = l.split(",");
    return { date, open: +open, high: +high, low: +low, close: +close, volume: +volume };
  });
}

export function backtest(candles, config) {
  const ctx = buildContext(candles);
  const feePct = (config.settings?.fee_pct_per_side ?? 0.1) / 100;
  const trades = [];
  let i = MIN_HISTORY;

  while (i < candles.length - 1) {
    const decision = evaluateRules(ctx, i, config);
    if (!decision || decision.action !== "long") { i++; continue; } // shorts: flip logic if you enable them

    const entryIdx = i + 1;
    const entry = candles[entryIdx].open;
    const stopPrice = entry * (1 - (decision.stop_pct ?? 100) / 100);
    // Exit spec: either the legacy timer (hold_candles) or pattern-based
    // exit {on_patterns: [...], max_hold: N} — exit at the open AFTER an
    // exit pattern completes on a closed candle, with max_hold as a cap.
    const exitSpec = decision.exit ?? null;
    const maxHold = exitSpec ? (exitSpec.max_hold ?? 15) : decision.hold_candles;
    const lastIdx = Math.min(entryIdx + maxHold - 1, candles.length - 1);

    let exit = null, exitIdx = lastIdx, reason = exitSpec ? "max-hold" : "hold-expiry";
    for (let j = entryIdx; j <= lastIdx && exit === null; j++) {
      const c = candles[j];
      if (c.open <= stopPrice) { exit = c.open; exitIdx = j; reason = "stop (gap)"; break; }
      if (c.low <= stopPrice) { exit = stopPrice; exitIdx = j; reason = "stop"; break; }
      if (exitSpec && j < candles.length - 1 && exitSpec.on_patterns.some((id) => PATTERNS[id].detect(ctx, j))) {
        exit = candles[j + 1].open; exitIdx = j + 1; reason = "exit-pattern";
      }
    }
    if (exit === null) exit = candles[lastIdx].close;

    const gross = (exit - entry) / entry;
    const net = (1 + gross) * (1 - feePct) / (1 + feePct) - 1; // fee on entry and exit
    trades.push({
      rule: decision.rule, signalIdx: i, signalDate: candles[i].date, entryDate: candles[entryIdx].date,
      exitDate: candles[exitIdx].date, entry, exit, netPct: net * 100, reason,
    });
    i = exitIdx + 1; // one position at a time
  }
  return trades;
}

function report(candles, trades, config) {
  const wins = trades.filter((t) => t.netPct > 0);
  let equity = 1, peak = 1, maxDD = 0;
  for (const t of trades) {
    equity *= 1 + t.netPct / 100;
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
  }
  const bh = (candles[candles.length - 1].close / candles[MIN_HISTORY].close - 1) * 100;
  const avg = trades.reduce((s, t) => s + t.netPct, 0) / (trades.length || 1);
  const grossWin = wins.reduce((s, t) => s + t.netPct, 0);
  const grossLoss = trades.filter((t) => t.netPct <= 0).reduce((s, t) => s - t.netPct, 0);

  console.log(`Candles: ${candles.length} (${candles[0].date} -> ${candles[candles.length - 1].date})`);
  console.log(`Fees: ${config.settings?.fee_pct_per_side ?? 0.1}% per side\n`);
  console.log(`Trades:        ${trades.length}`);
  console.log(`Win rate:      ${((wins.length / (trades.length || 1)) * 100).toFixed(1)}%`);
  console.log(`Avg net/trade: ${avg.toFixed(2)}%`);
  console.log(`Profit factor: ${grossLoss ? (grossWin / grossLoss).toFixed(2) : "inf"}`);
  console.log(`Total return:  ${((equity - 1) * 100).toFixed(1)}% (compounded, one position at a time)`);
  console.log(`Max drawdown:  ${(maxDD * 100).toFixed(1)}% (trade-to-trade equity)`);
  console.log(`Buy & hold:    ${bh.toFixed(1)}% over the same period`);

  console.log(`\nPer rule:`);
  const byRule = {};
  for (const t of trades) (byRule[t.rule] ??= []).push(t);
  for (const [rule, ts] of Object.entries(byRule)) {
    const w = ts.filter((t) => t.netPct > 0).length;
    const a = ts.reduce((s, t) => s + t.netPct, 0) / ts.length;
    console.log(`  ${rule.padEnd(28)} ${String(ts.length).padStart(4)} trades | win ${((w / ts.length) * 100).toFixed(1).padStart(5)}% | avg ${a.toFixed(2).padStart(6)}%`);
  }

  console.log(`\nExit reasons:`);
  const byReason = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] || 0) + 1;
  for (const [r, n] of Object.entries(byReason)) console.log(`  ${r}: ${n}`);

  console.log(`\nLast 5 trades:`);
  for (const t of trades.slice(-5)) {
    console.log(`  ${t.entryDate} -> ${t.exitDate}  ${t.rule}  ${t.netPct >= 0 ? "+" : ""}${t.netPct.toFixed(2)}%  (${t.reason})`);
  }
}

// ── main (skipped when imported by bot.js) ───────────────────────────────────
if (import.meta.url === new URL(`file://${process.argv[1]}`).href || process.argv[1]?.endsWith("pattern-backtest.js")) {
  const file = process.argv[2] || "btc-daily-binance.csv";
  const config = JSON.parse(readFileSync("pattern-rules.json", "utf8"));
  const candles = loadCsv(file);
  console.log(`=== Pattern rule backtest: ${file} ===\n`);
  report(candles, backtest(candles, config), config);
}
