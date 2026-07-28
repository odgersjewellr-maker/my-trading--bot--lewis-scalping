#!/usr/bin/env node
/**
 * London -> New York  session direction-continuation study
 * ---------------------------------------------------------
 * Question: after the LONDON session establishes a direction, how often does the
 * NEW YORK session keep going the same way — and is that edge tradeable?
 *
 * Feed it an OHLCV CSV (1-minute or 1-hour; plain .csv or gzipped .csv.gz).
 * Column names are auto-detected. Accepted timestamp columns: timestamp / time /
 * date / datetime / "open time"  (unix seconds, unix ms, or ISO string).
 * Accepted price columns: open, high, low, close (volume optional).
 *
 *   node analyze.mjs <path-to-ohlcv.csv[.gz]>
 *
 * Session boundaries are UTC hours, overridable by env vars (see CONF).
 * Defaults model the "classic" London-open -> NY-open handoff. Because London/NY
 * wall-clock opens shift with daylight-saving, run a couple of definitions
 * (e.g. L_OPEN=7 and L_OPEN=8) and confirm the conclusions hold on both — the
 * repo's findings report does exactly this.
 *
 * Outputs: prints a full report and writes <out>.json + <out>.txt next to the CSV
 * (or to $OUT_DIR). No network, no dependencies — plain Node >= 18.
 */
import fs from "fs";
import zlib from "zlib";
import readline from "readline";
import path from "path";

// ----------------------------- config -----------------------------
const FILE = process.argv[2];
if (!FILE) { console.error("usage: node analyze.mjs <ohlcv.csv[.gz]>"); process.exit(1); }

const CONF = {
  L_OPEN:  +(process.env.L_OPEN  ?? 7),   // London open hour, UTC  (London-led window start)
  NY_OPEN: +(process.env.NY_OPEN ?? 12),  // New York open hour, UTC (handoff boundary)
  NY_END:  +(process.env.NY_END  ?? 20),  // end of NY follow-through window, UTC
  START_YEAR: +(process.env.START_YEAR ?? 2019), // focus window for the detailed stats
  WEEKDAYS_ONLY: (process.env.WEEKDAYS_ONLY ?? "1") !== "0", // session effects are TradFi-driven
  TREND_LOOKBACK: +(process.env.TREND_LOOKBACK ?? 20),       // days, for the daily-trend filter
};
const OUT_DIR = process.env.OUT_DIR ?? path.dirname(path.resolve(FILE));
const OUT_BASE = path.join(OUT_DIR, "session-direction-results");

// --------------------------- csv streaming ---------------------------
function makeStream(p) {
  const raw = fs.createReadStream(p);
  return p.endsWith(".gz") ? raw.pipe(zlib.createGunzip()) : raw;
}
let header = null, iTs = -1, iO = -1, iH = -1, iL = -1, iC = -1, nRows = 0;
function detectCols(cols) {
  const low = cols.map(c => c.trim().toLowerCase().replace(/^"|"$/g, ""));
  const find = (...n) => low.findIndex(c => n.includes(c));
  iTs = find("timestamp", "time", "date", "datetime", "open time", "opentime");
  iO = find("open"); iH = find("high"); iL = find("low"); iC = find("close");
  if ([iTs, iO, iH, iL, iC].some(i => i < 0))
    throw new Error("could not find timestamp/open/high/low/close columns in: " + low.join(","));
}
function parseTs(v) {
  v = v.trim().replace(/^"|"$/g, "");
  if (/^\d+$/.test(v)) { let n = Number(v); if (v.length >= 13) n = Math.floor(n / 1000); return new Date(n * 1000); }
  return new Date(v.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? "" : "Z"));
}

// --------------------------- per-day aggregation ---------------------------
// Only candles inside [L_OPEN, NY_END) are kept. For each UTC day we record the
// London-window open + range, the NY-window open + range + hourly closes.
const days = new Map();
function processLine(line) {
  if (!line) return;
  if (header === null) { header = line; detectCols(line.split(",")); return; }
  const p = line.split(",");
  const d = parseTs(p[iTs]); const t = d.getTime(); if (Number.isNaN(t)) return;
  const hh = d.getUTCHours();
  if (hh < CONF.L_OPEN || hh >= CONF.NY_END) return;
  const o = +p[iO], hi = +p[iH], lo = +p[iL], c = +p[iC];
  if (!(o > 0) || !(c > 0)) return;
  const key = d.toISOString().slice(0, 10);
  let r = days.get(key);
  if (!r) { r = { lOpen: null, lHigh: -Infinity, lLow: Infinity, nyOpen: null, nyHigh: -Infinity, nyLow: Infinity, hc: {}, dow: d.getUTCDay() }; days.set(key, r); }
  if (hh < CONF.NY_OPEN) {                      // London-led window
    if (r.lOpen === null) r.lOpen = o;
    if (hi > r.lHigh) r.lHigh = hi;
    if (lo < r.lLow)  r.lLow  = lo;
  } else {                                      // NY window
    if (r.nyOpen === null) r.nyOpen = o;
    if (hi > r.nyHigh) r.nyHigh = hi;
    if (lo < r.nyLow)  r.nyLow  = lo;
    r.hc[hh] = c;                               // last close seen in each NY hour
  }
  nRows++;
}

// ------------------------------- stats helpers -------------------------------
const sign = x => (x > 0 ? 1 : x < 0 ? -1 : 0);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct  = x => (100 * x).toFixed(2) + "%";
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
function binom(k, n, p0 = 0.5) {                // rate, 95% CI (Wald), z vs p0
  const p = k / n, se = Math.sqrt(p * (1 - p) / n), z = (p - p0) / Math.sqrt(p0 * (1 - p0) / n);
  return { p, lo: p - 1.96 * se, hi: p + 1.96 * se, z, n, k };
}
function tradeStats(dr) {
  const w = dr.filter(x => x > 0), l = dr.filter(x => x < 0);
  return { n: dr.length, avg: mean(dr), win: dr.length ? w.length / dr.length : 0,
    avgW: mean(w), avgL: mean(l), median: median(dr),
    pf: w.reduce((s, x) => s + x, 0) / Math.abs(l.reduce((s, x) => s + x, 0) || 1e-9) };
}

// ---------------------------------- run ----------------------------------
function run() {
  // build ordered per-day records + rolling daily-trend reference
  const raw = [];
  for (const [date, r] of days) {
    if (r.lOpen === null || r.nyOpen === null || r.hc[CONF.NY_END - 1] == null) continue;
    raw.push({ date, year: +date.slice(0, 4), dow: r.dow, lOpen: r.lOpen, lHigh: r.lHigh, lLow: r.lLow,
      boundary: r.nyOpen, nyHigh: r.nyHigh, nyLow: r.nyLow, hc: r.hc, dayClose: r.hc[CONF.NY_END - 1] });
  }
  raw.sort((a, b) => (a.date < b.date ? -1 : 1));
  for (let i = 0; i < raw.length; i++) {
    const w = raw.slice(Math.max(0, i - CONF.TREND_LOOKBACK), i);
    raw[i].sma = w.length ? mean(w.map(x => x.dayClose)) : raw[i].lOpen;
  }
  // weekday records with a non-flat London direction
  const recs = raw
    .filter(r => !(CONF.WEEKDAYS_ONLY && (r.dow === 0 || r.dow === 6)))
    .map(r => { const lRet = (r.boundary - r.lOpen) / r.lOpen; return { ...r, lRet, D: sign(lRet) }; })
    .filter(r => r.D !== 0);

  const focus = recs.filter(r => r.year >= CONF.START_YEAR);
  const out = [];
  const log = (...a) => { const s = a.join(" "); out.push(s); console.log(s); };
  const contClose = r => sign(r.dayClose - r.boundary) === r.D ? 1 : 0;

  log("================================================================");
  log(" LONDON -> NEW YORK  DIRECTION-CONTINUATION STUDY");
  log("================================================================");
  log(`data file        : ${path.basename(FILE)}   (rows in window: ${nRows.toLocaleString()})`);
  log(`session (UTC)     : London-led ${CONF.L_OPEN}:00->${CONF.NY_OPEN}:00 | NY ${CONF.NY_OPEN}:00->${CONF.NY_END}:00`);
  log(`sample            : ${recs.length} weekday days (${recs[0].date} -> ${recs[recs.length - 1].date})`);
  log(`detailed window   : ${CONF.START_YEAR}+  (n=${focus.length})`);
  log("");
  const summary = { config: CONF, sample: { days: recs.length, from: recs[0].date, to: recs[recs.length - 1].date } };

  // 1) headline continuation, per era + directional split
  log("--- 1. Does NY close in London's direction? ---");
  summary.headline = [];
  for (const [name, rs] of [["all years", recs], [`${CONF.START_YEAR}+`, focus],
                            ["2021+", recs.filter(r => r.year >= 2021)]]) {
    if (rs.length < 50) continue;
    const up = rs.filter(r => r.D > 0), dn = rs.filter(r => r.D < 0);
    const b = binom(rs.filter(contClose).length, rs.length);
    const bu = binom(up.filter(contClose).length, up.length);
    const bd = binom(dn.filter(contClose).length, dn.length);
    const baseUp = rs.filter(r => r.dayClose > r.boundary).length / rs.length;
    log(`  ${name.padEnd(9)}: continue ${pct(b.p)} [CI ${pct(b.lo)}-${pct(b.hi)}] z=${b.z.toFixed(1)} | after UP ${pct(bu.p)} | after DOWN ${pct(bd.p)} | base P(NY up) ${pct(baseUp)}`);
    summary.headline.push({ era: name, n: rs.length, continue: b.p, z: b.z, afterUp: bu.p, afterDown: bd.p, baseUp });
  }
  log("");

  // 2) decay curve — WHEN in the NY session does the edge live?
  log(`--- 2. Continuation decay: P(still in London dir) at NY_open + kh  [${CONF.START_YEAR}+] ---`);
  summary.decay = [];
  for (let k = 1; k <= CONF.NY_END - CONF.NY_OPEN; k++) {
    const hr = CONF.NY_OPEN + k - 1;
    const rs = focus.filter(r => r.hc[hr] != null);
    const cont = rs.filter(r => sign(r.hc[hr] - r.boundary) === r.D).length;
    const dirMove = mean(rs.map(r => r.D * (r.hc[hr] - r.boundary) / r.boundary));
    const b = binom(cont, rs.length);
    log(`  +${k}h (by ${hr + 1}:00): continue ${pct(b.p)}  z=${b.z.toFixed(1)}  avgDirMove ${pct(dirMove)}  n=${rs.length}`);
    summary.decay.push({ k, byHour: hr + 1, continue: b.p, z: b.z, avgDirMove: dirMove, n: rs.length });
  }
  log("");

  // 3) fade vs follow $-expectancy with payoff asymmetry (the honesty check)
  log(`--- 3. FADE vs FOLLOW gross expectancy (enter at NY open, exit +kh) [${CONF.START_YEAR}+] ---`);
  summary.fadeFollow = [];
  for (const k of [1, 2, 3, 4, CONF.NY_END - CONF.NY_OPEN]) {
    const hr = Math.min(CONF.NY_OPEN + k - 1, CONF.NY_END - 1);
    const rs = focus.filter(r => r.hc[hr] != null);
    const follow = rs.map(r => r.D * (r.hc[hr] - r.boundary) / r.boundary);
    const F = tradeStats(follow), Fa = tradeStats(follow.map(x => -x));
    log(`  +${k}h  FOLLOW win ${pct(F.win)} avg ${pct(F.avg)} PF ${F.pf.toFixed(2)} | FADE win ${pct(Fa.win)} avg ${pct(Fa.avg)} PF ${Fa.pf.toFixed(2)} (avgW +${pct(Fa.avgW)} avgL ${pct(Fa.avgL)})`);
    summary.fadeFollow.push({ k, follow: F, fade: Fa });
  }
  log("");

  // 4) directional split of the early fade (long-bias check)
  log(`--- 4. Early NY-open fade split by London direction [${CONF.START_YEAR}+, exit +2h] ---`);
  const hr2 = CONF.NY_OPEN + 1;
  summary.fadeSplit = {};
  for (const [name, filt, key] of [["London UP  -> fade = SHORT", r => r.D > 0, "up"],
                                   ["London DOWN -> fade = LONG ", r => r.D < 0, "down"]]) {
    const rs = focus.filter(r => filt(r) && r.hc[hr2] != null);
    const s = tradeStats(rs.map(r => -r.D * (r.hc[hr2] - r.boundary) / r.boundary));
    log(`  ${name}: n=${s.n} win ${pct(s.win)} avg ${pct(s.avg)} PF ${s.pf.toFixed(2)}`);
    summary.fadeSplit[key] = s;
  }
  log("");

  // 5) trend-alignment filter (does aligning London dir with the daily trend help?)
  log(`--- 5. Trend-alignment filter (net-close continuation) [${CONF.START_YEAR}+] ---`);
  const aligned = focus.filter(r => (r.D > 0 && r.boundary > r.sma) || (r.D < 0 && r.boundary < r.sma));
  const against = focus.filter(r => (r.D > 0 && r.boundary < r.sma) || (r.D < 0 && r.boundary > r.sma));
  const alignedPush = aligned.filter(r => Math.abs(r.lRet) >= 0.005);
  summary.trend = {};
  for (const [name, rs, key] of [["aligned with trend  ", aligned, "aligned"],
                                 ["against trend        ", against, "against"],
                                 ["aligned + push>=0.5% ", alignedPush, "alignedPush"]]) {
    if (rs.length < 30) continue;
    const c = rs.filter(contClose).length / rs.length;
    const t = tradeStats(rs.map(r => r.D * (r.dayClose - r.boundary) / r.boundary));
    log(`  ${name}: continue ${pct(c)}  followPF ${t.pf.toFixed(2)}  avgDirRet ${pct(t.avg)}  n=${rs.length}`);
    summary.trend[key] = { continue: c, pf: t.pf, avg: t.avg, n: rs.length };
  }
  log("");

  // 6) NY session volatility for stop/target sizing
  log(`--- 6. NY session volatility (for sizing) [${CONF.START_YEAR}+] ---`);
  const rng = focus.map(r => (r.nyHigh - r.nyLow) / r.boundary);
  const netAbs = focus.map(r => Math.abs(r.dayClose - r.boundary) / r.boundary);
  const lMove = focus.map(r => Math.abs(r.lRet));
  log(`  NY high-low range : mean ${pct(mean(rng))}  median ${pct(median(rng))}`);
  log(`  |net open->close|  : mean ${pct(mean(netAbs))}  median ${pct(median(netAbs))}`);
  log(`  London move into NY: mean |move| ${pct(mean(lMove))}`);
  summary.volatility = { nyRangeMean: mean(rng), nyRangeMedian: median(rng),
    netMoveMean: mean(netAbs), netMoveMedian: median(netAbs), londonMoveMean: mean(lMove) };

  fs.writeFileSync(OUT_BASE + ".json", JSON.stringify(summary, null, 2));
  fs.writeFileSync(OUT_BASE + ".txt", out.join("\n"));
  log(`[written ${path.basename(OUT_BASE)}.json + .txt]`);
}

const rl = readline.createInterface({ input: makeStream(FILE), crlfDelay: Infinity });
rl.on("line", processLine);
rl.on("close", run);
