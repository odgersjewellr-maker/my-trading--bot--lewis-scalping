/**
 * Turtle Soup — daily review & next-day fit.
 *
 * A morning tool: look at how the strategy behaved on the previous session and
 * decide what (if anything) to change for the next one.
 *
 *   1. REVIEW  — pulls recent candles for your forward-test symbol/timeframe,
 *      isolates the last completed UTC day, and lists every Turtle Soup setup on
 *      that day with its hypothetical entry / stop / target and how it resolved.
 *   2. FIT     — sweeps the parameter grid over a *trailing window* (not just
 *      yesterday) and reports the configs that performed best, plus a ready-to-
 *      paste recommendation. It only suggests a change when one clearly beats
 *      your current params — fitting to a single day is overfitting, and this
 *      tool refuses to pretend otherwise.
 *   3. CHART   — writes a self-contained candlestick chart (review-<key>.html)
 *      of the recent window with BUY/SELL markers, for eyeballing.
 *
 * Usage:
 *   node review.js                       # fetch live candles for SYMBOL/TIMEFRAME
 *   node review.js --csv btc-daily-binance.csv
 *   node review.js --day 2026-07-13 --fit-bars 480 --chart-bars 120
 *
 * Reads the same env the bot does (SYMBOL, TIMEFRAME, INSTANCE_ID, TS_*, RISK_PCT).
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { turtleSoupSignal, turtleSoupPlan, simulateTurtleSoup, tsParamsFromEnv } from "./turtle-soup.js";
import { regimeParamsFromEnv, detectRegimeSeries, adaptationFor } from "./regime.js";
import { CONFIG, fetchCandles } from "./bot.js";

// ─── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const has = (name) => args.includes(name);
const csvArg    = flag("--csv", null);
const dayArg    = flag("--day", null);
const fitBars   = parseInt(flag("--fit-bars", "480"));   // ~5 days of 15m
const chartBars = parseInt(flag("--chart-bars", "120"));
const minTrades = parseInt(flag("--min-trades", "12"));  // a config needs this many samples to be trusted
const doFit     = !has("--no-fit");
const doChart   = !has("--no-chart");

const KEY = process.env.INSTANCE_ID || CONFIG.symbol;
const riskPct = parseFloat(process.env.RISK_PCT || "5") / 100;
const feeRate = parseFloat(process.env.PAPER_FEE_RATE || "0.0008");
const current = tsParamsFromEnv();
const regimeCfg = regimeParamsFromEnv();

// ─── load candles (live fetch, CSV fallback) ─────────────────────────────────
function fromCsv(path) {
  return readFileSync(resolve(path), "utf8").trim().split("\n").slice(1)
    .map((l) => {
      const [date, o, h, lo, c, v] = l.split(",");
      return { dayKey: (date || "").trim(), label: (date || "").trim(),
               open: +o, high: +h, low: +lo, close: +c, volume: +v };
    })
    .filter((c) => !isNaN(c.close));
}
function normalizeFetched(candles) {
  return candles.map((c) => {
    const d = new Date(c.time);
    return { ...c, dayKey: d.toISOString().slice(0, 10),
             label: d.toISOString().slice(5, 16).replace("T", " ") };
  });
}

let candles, source;
if (csvArg) {
  candles = fromCsv(csvArg);
  source = `CSV ${csvArg}`;
} else {
  try {
    const need = Math.max(fitBars + current.lookback + 5, 200);
    candles = normalizeFetched(await fetchCandles(CONFIG.symbol, CONFIG.timeframe, Math.min(need, 1000)));
    source = `${CONFIG.symbol} ${CONFIG.timeframe} (live BitGet)`;
  } catch (err) {
    candles = fromCsv("btc-daily-binance.csv");
    source = `btc-daily-binance.csv (live fetch failed: ${err.message})`;
  }
}
if (candles.length < current.lookback + 5) {
  console.error(`Not enough candles (${candles.length}) to review.`);
  process.exit(1);
}

// ─── header ──────────────────────────────────────────────────────────────────
const fmt = (n) => (n >= 1000 ? n.toFixed(0) : n.toFixed(2));
console.log("═══════════════════════════════════════════════════════════");
console.log(`  Turtle Soup — Daily Review   [${KEY}]`);
console.log(`  Source: ${source}   (${candles.length} bars, ${candles[0].dayKey} → ${candles[candles.length - 1].dayKey})`);
console.log(`  Current params: lookback ${current.lookback} | min age ${current.minPriorAgeBars} | R:R ${current.rewardRisk} | maxHold ${current.maxHoldBars} | ${current.allowLong ? "long " : ""}${current.allowShort ? "short" : ""}`);
if (regimeCfg.on) {
  const { regime, trendPct } = detectRegimeSeries(candles, regimeCfg);
  const now = regime[regime.length - 1];
  const a = adaptationFor(now, regimeCfg);
  const icon = now === "bull" ? "🐂" : now === "bear" ? "🐻" : "➡️";
  console.log(`  Regime: ON (SMA${regimeCfg.trendLen}) — now ${icon} ${now.toUpperCase()} (${trendPct[trendPct.length - 1] >= 0 ? "+" : ""}${trendPct[trendPct.length - 1].toFixed(2)}% vs SMA) → ${a.allowLong ? "long " : ""}${a.allowShort ? "short " : ""}| size ×${a.sizeMult} | hold ×${a.holdMult}`);
} else {
  console.log("  Regime: OFF (set REGIME_ON=true to adapt direction/size/hold to bull/bear/flat)");
}
console.log("═══════════════════════════════════════════════════════════");

// ─── 1. Review the previous completed day ────────────────────────────────────
const dayKeys = [...new Set(candles.map((c) => c.dayKey))];
const reviewDay = dayArg || (dayKeys.length >= 2 ? dayKeys[dayKeys.length - 2] : dayKeys[0]);
const dayIdx = candles.map((c, i) => (c.dayKey === reviewDay ? i : -1)).filter((i) => i >= 0);

console.log(`\n── Review day: ${reviewDay} ────────────────────────────────`);
if (dayIdx.length === 0) {
  console.log(`  No candles for ${reviewDay}.`);
} else {
  const dbars = dayIdx.map((i) => candles[i]);
  const dHigh = Math.max(...dbars.map((c) => c.high));
  const dLow = Math.min(...dbars.map((c) => c.low));
  const chg = ((dbars[dbars.length - 1].close - dbars[0].open) / dbars[0].open) * 100;
  console.log(`  ${dbars.length} bars | range $${fmt(dLow)}–$${fmt(dHigh)} | day change ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`);

  // Regime label per bar (for annotating whether a setup would be taken).
  const regimeArr = regimeCfg.on ? detectRegimeSeries(candles, regimeCfg).regime : null;

  // Every setup that fired on the review day (taken or not), with what would follow.
  const setups = [];
  for (const i of dayIdx) {
    const sig = turtleSoupSignal(candles.slice(0, i + 1), current);
    if (sig.signal) setups.push({ i, sig });
  }
  if (setups.length === 0) {
    console.log("  No Turtle Soup setups fired this day (with current params).");
  } else {
    console.log(`  ${setups.length} setup(s):`);
    for (const { i, sig } of setups) {
      const plan = turtleSoupPlan(sig, candles[i].close, current);
      // Resolve forward: walk subsequent bars until stop / target / time.
      let outcome = "open at data end", rr = null;
      for (let k = i + 1, held = 0; k < candles.length && held < plan.maxHoldBars; k++, held++) {
        const b = candles[k];
        if (plan.side === "long") {
          if (b.low <= plan.stop) { outcome = `stop @ $${fmt(plan.stop)} (−1R)`; rr = -1; break; }
          if (b.high >= plan.target) { outcome = `target @ $${fmt(plan.target)} (+${plan.rewardRisk}R)`; rr = plan.rewardRisk; break; }
        } else {
          if (b.high >= plan.stop) { outcome = `stop @ $${fmt(plan.stop)} (−1R)`; rr = -1; break; }
          if (b.low <= plan.target) { outcome = `target @ $${fmt(plan.target)} (+${plan.rewardRisk}R)`; rr = plan.rewardRisk; break; }
        }
        if (held + 1 >= plan.maxHoldBars) { outcome = `time-stop @ $${fmt(b.close)}`; }
      }
      let tag = "";
      if (regimeArr) {
        const a = adaptationFor(regimeArr[i], regimeCfg);
        const taken = sig.side === "long" ? a.allowLong : a.allowShort;
        tag = `  [${regimeArr[i]}${taken ? "" : " · SKIPPED by regime"}]`;
      }
      console.log(`   • ${candles[i].label}  ${sig.signal.padEnd(4)} entry $${fmt(candles[i].close)} stop $${fmt(plan.stop)} target $${fmt(plan.target)} → ${outcome}${tag}`);
    }
  }
}

// ─── 2. Fit over a trailing window ───────────────────────────────────────────
function score(params, window) {
  return simulateTurtleSoup(window, params, { riskPct, feeRate, startEquity: 1000, regime: regimeCfg }).stats;
}
if (doFit) {
  const window = candles.slice(-Math.min(fitBars, candles.length));
  const cur = score(current, window);
  console.log(`\n── Fit over last ${window.length} bars (${window[0].dayKey} → ${window[window.length - 1].dayKey}) ──`);
  console.log(`  Current params in-window: ${cur.trades} trades | win ${(cur.winRate * 100).toFixed(0)}% | PF ${cur.profitFactor === Infinity ? "∞" : cur.profitFactor.toFixed(2)} | P&L $${cur.pnl.toFixed(2)}`);

  const grid = [];
  for (const lookback of [15, 20, 30])
    for (const minPriorAgeBars of [2, 3, 5])
      for (const rewardRisk of [1, 1.5, 2, 3])
        for (const maxHoldBars of [3, 4, 6])
          for (const dir of [["both", true, true], ["long", true, false], ["short", false, true]])
            grid.push({ lookback, minPriorAgeBars, rewardRisk, maxHoldBars, allowLong: dir[1], allowShort: dir[2], buffer: current.buffer, _dir: dir[0] });

  const ranked = grid
    .map((p) => ({ p, s: score(p, window) }))
    .filter((r) => r.s.trades >= minTrades) // ignore configs with too few samples to trust
    .sort((a, b) => (b.s.profitFactor - a.s.profitFactor) || (b.s.pnl - a.s.pnl));

  if (ranked.length === 0) {
    console.log(`  No config reached ${minTrades}+ trades in this window — sample too thin to fit on.`);
    console.log("  Widen --fit-bars, lower --min-trades (at your own risk), or just wait for more data.");
  } else {
    console.log("  Top configs in-window (descriptive, NOT a guarantee):");
    for (const { p, s } of ranked.slice(0, 5)) {
      console.log(`   lookback ${String(p.lookback).padStart(2)} age ${p.minPriorAgeBars} R:R ${p.rewardRisk} hold ${p.maxHoldBars} ${p._dir.padEnd(5)} → ${s.trades}t win ${(s.winRate * 100).toFixed(0)}% PF ${s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2)} P&L $${s.pnl.toFixed(2)}`);
    }
    const best = ranked[0];
    const materiallyBetter = best.s.profitFactor >= Math.max(cur.profitFactor * 1.15, 1.05) && best.s.pnl > cur.pnl;
    console.log("\n  ── Recommendation for next session ──");
    if (materiallyBetter) {
      console.log("  A config clearly beat your current params in-window. To try it, set:");
      console.log(`     TS_LOOKBACK=${best.p.lookback}  TS_MIN_AGE_BARS=${best.p.minPriorAgeBars}  TS_REWARD_RISK=${best.p.rewardRisk}  TS_MAX_HOLD_BARS=${best.p.maxHoldBars}  TS_ALLOW_LONG=${best.p.allowLong}  TS_ALLOW_SHORT=${best.p.allowShort}`);
      console.log("  ⚠️  Change ONE thing at a time so you can attribute the effect. This is fit to the past;");
      console.log("      forward-test it before trusting it — a single window overfits easily.");
    } else {
      console.log("  Keep current params. Nothing beat them by a margin worth chasing — the differences");
      console.log("  are within noise for this window, and changing on noise is how you overfit.");
    }
  }
}

// ─── 3. Chart ────────────────────────────────────────────────────────────────
if (doChart) {
  const view = candles.slice(-Math.min(chartBars, candles.length));
  const off = candles.length - view.length;
  const sigs = [];
  for (let i = 0; i < view.length; i++) {
    const s = turtleSoupSignal(candles.slice(0, off + i + 1), current);
    if (s.signal) sigs.push({ i, side: s.signal });
  }
  const html = renderChartHtml(view, sigs, KEY, reviewDay);
  const out = `review-${KEY}.html`;
  writeFileSync(out, html);
  console.log(`\n📈 Chart written → ${out}  (open it, or ask Claude to publish it)`);
}

console.log("\n═══════════════════════════════════════════════════════════\n");

// ─── SVG candlestick chart (self-contained, theme-aware) ─────────────────────
function renderChartHtml(view, sigs, key, reviewDay) {
  const W = 1100, H = 460, mL = 60, mR = 20, mT = 30, mB = 40;
  const iw = W - mL - mR, ih = H - mT - mB;
  const hi = Math.max(...view.map((c) => c.high));
  const lo = Math.min(...view.map((c) => c.low));
  const pad = (hi - lo) * 0.05 || 1;
  const yHi = hi + pad, yLo = lo - pad;
  const x = (i) => mL + (i + 0.5) * (iw / view.length);
  const y = (p) => mT + (yHi - p) / (yHi - yLo) * ih;
  const bw = Math.max(1, (iw / view.length) * 0.6);

  let bars = "";
  for (let i = 0; i < view.length; i++) {
    const c = view[i];
    const up = c.close >= c.open;
    const col = up ? "var(--up)" : "var(--down)";
    const bodyT = y(Math.max(c.open, c.close));
    const bodyB = y(Math.min(c.open, c.close));
    bars += `<line x1="${x(i).toFixed(1)}" y1="${y(c.high).toFixed(1)}" x2="${x(i).toFixed(1)}" y2="${y(c.low).toFixed(1)}" stroke="${col}" stroke-width="1"/>`;
    bars += `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${bodyT.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, bodyB - bodyT).toFixed(1)}" fill="${col}"/>`;
  }
  let marks = "";
  for (const s of sigs) {
    const c = view[s.i];
    if (s.side === "BUY") {
      const yy = y(c.low) + 12;
      marks += `<path d="M${x(s.i)},${(yy - 8).toFixed(1)} l-5,8 l10,0 z" fill="var(--buy)"/>`;
    } else {
      const yy = y(c.high) - 12;
      marks += `<path d="M${x(s.i)},${(yy + 8).toFixed(1)} l-5,-8 l10,0 z" fill="var(--sell)"/>`;
    }
  }
  // y-axis gridlines
  let grid = "";
  for (let g = 0; g <= 4; g++) {
    const p = yLo + (g / 4) * (yHi - yLo);
    const yy = y(p);
    grid += `<line x1="${mL}" y1="${yy.toFixed(1)}" x2="${W - mR}" y2="${yy.toFixed(1)}" stroke="var(--grid)" stroke-width="0.5"/>`;
    grid += `<text x="${mL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--fg-dim)">${p >= 1000 ? p.toFixed(0) : p.toFixed(2)}</text>`;
  }
  // day separators + labels
  let axis = "";
  let lastDay = null;
  for (let i = 0; i < view.length; i++) {
    if (view[i].dayKey !== lastDay) {
      lastDay = view[i].dayKey;
      const xx = x(i) - (bw / 2);
      axis += `<line x1="${xx.toFixed(1)}" y1="${mT}" x2="${xx.toFixed(1)}" y2="${mT + ih}" stroke="var(--grid)" stroke-width="0.5" stroke-dasharray="3 3"/>`;
      axis += `<text x="${(xx + 3).toFixed(1)}" y="${(mT + ih + 14).toFixed(1)}" font-size="10" fill="var(--fg-dim)">${lastDay}</text>`;
    }
  }
  const nBuy = sigs.filter((s) => s.side === "BUY").length;
  const nSell = sigs.filter((s) => s.side === "SELL").length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Turtle Soup review — ${key}</title>
<style>
  :root { --bg:#fff; --fg:#111; --fg-dim:#666; --grid:#e5e5e5; --up:#16a34a; --down:#dc2626; --buy:#16a34a; --sell:#dc2626; --card:#f7f7f8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d0d0f; --fg:#eaeaea; --fg-dim:#999; --grid:#242428; --up:#3fb950; --down:#f85149; --buy:#3fb950; --sell:#f85149; --card:#17171a; } }
  :root[data-theme="dark"] { --bg:#0d0d0f; --fg:#eaeaea; --fg-dim:#999; --grid:#242428; --up:#3fb950; --down:#f85149; --buy:#3fb950; --sell:#f85149; --card:#17171a; }
  :root[data-theme="light"] { --bg:#fff; --fg:#111; --fg-dim:#666; --grid:#e5e5e5; --up:#16a34a; --down:#dc2626; --buy:#16a34a; --sell:#dc2626; --card:#f7f7f8; }
  body { margin:0; background:var(--bg); color:var(--fg); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; padding:20px; }
  .head { display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:8px; margin-bottom:8px; }
  h1 { font-size:16px; margin:0; font-weight:600; }
  .meta { font-size:12px; color:var(--fg-dim); }
  .legend { font-size:12px; color:var(--fg-dim); margin-top:6px; display:flex; gap:16px; }
  .chart { width:100%; overflow-x:auto; background:var(--card); border-radius:10px; padding:8px; box-sizing:border-box; }
  svg { min-width:700px; width:100%; height:auto; display:block; }
</style>
</head>
<body>
<div class="head">
  <h1>Turtle Soup — ${key}</h1>
  <span class="meta">${view[0].dayKey} → ${view[view.length - 1].dayKey} · ${view.length} bars · review day ${reviewDay}</span>
</div>
<div class="legend">
  <span>▲ BUY (false breakdown): ${nBuy}</span>
  <span>▼ SELL (false breakout): ${nSell}</span>
</div>
<div class="chart">
  <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    ${grid}${axis}${bars}${marks}
  </svg>
</div>
</body>
</html>`;
}
