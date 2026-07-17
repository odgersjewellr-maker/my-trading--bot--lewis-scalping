/**
 * pattern-chart.js — renders the pattern library onto an interactive chart.
 *
 * Reads an OHLCV CSV, runs every detector in patterns.js on every candle, and
 * writes pattern-chart.html: a self-contained page (no external assets) with
 * candlesticks, SMA50/EMA8 overlays, toggleable pattern markers, crosshair
 * tooltip listing what fired on each candle, and a data-table view.
 *
 * Usage: node pattern-chart.js [csv-file] [output.html]
 */

import { readFileSync, writeFileSync } from "fs";
import { buildContext, PATTERNS, MIN_HISTORY } from "./patterns.js";

const file = process.argv[2] || "btc-daily-binance.csv";
const out = process.argv[3] || "pattern-chart.html";

const candles = readFileSync(file, "utf8").trim().split("\n").slice(1).map((l) => {
  const [date, open, high, low, close, volume] = l.split(",");
  return { d: date, o: +open, h: +high, l: +low, c: +close };
});
const full = candles.map((c) => ({ date: c.d, open: c.o, high: c.h, low: c.l, close: c.c, volume: 0 }));
const ctx = buildContext(full);

const meta = Object.entries(PATTERNS).map(([id, p]) => ({ id, name: p.name, dir: p.dir, count: 0 }));
const fired = candles.map((_, i) => {
  const ids = [];
  if (i >= MIN_HISTORY) {
    for (const m of meta) if (PATTERNS[m.id].detect(ctx, i)) { ids.push(m.id); m.count++; }
  }
  return ids;
});

const payload = JSON.stringify({
  symbol: file.replace(/\.csv$/, ""),
  candles,
  fired,
  sma50: ctx.sma50.map((v) => (v === null ? null : +v.toFixed(2))),
  ema8: ctx.ema8.map((v) => (v === null ? null : +v.toFixed(2))),
  meta,
});

const html = `<title>Pattern Map — ${file}</title>
<style>
:root{
  --bg:#f6f5f2; --panel:#fdfcfa; --ink:#22262b; --ink-2:#5c6470; --ink-3:#9aa1ab;
  --line:#e3e0da; --up:#1f8a70; --down:#d84a3c; --sma:#8656c9; --ema:#8a7a1e;
  --chip:#eceae5; --chip-on:#22262b; --chip-on-ink:#f6f5f2; --tip:#fdfcfa;
}
@media (prefers-color-scheme: dark){:root{
  --bg:#15181d; --panel:#1b1f26; --ink:#e6e4df; --ink-2:#a8adb5; --ink-3:#6b727c;
  --line:#2a2f37; --up:#26a07f; --down:#e0523f; --sma:#9a76dd; --ema:#a08631;
  --chip:#242932; --chip-on:#e6e4df; --chip-on-ink:#15181d; --tip:#1b1f26;
}}
:root[data-theme="dark"]{
  --bg:#15181d; --panel:#1b1f26; --ink:#e6e4df; --ink-2:#a8adb5; --ink-3:#6b727c;
  --line:#2a2f37; --up:#26a07f; --down:#e0523f; --sma:#9a76dd; --ema:#a08631;
  --chip:#242932; --chip-on:#e6e4df; --chip-on-ink:#15181d; --tip:#1b1f26;
}
:root[data-theme="light"]{
  --bg:#f6f5f2; --panel:#fdfcfa; --ink:#22262b; --ink-2:#5c6470; --ink-3:#9aa1ab;
  --line:#e3e0da; --up:#1f8a70; --down:#d84a3c; --sma:#8656c9; --ema:#8a7a1e;
  --chip:#eceae5; --chip-on:#22262b; --chip-on-ink:#f6f5f2; --tip:#fdfcfa;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:20px 20px 48px;display:flex;flex-direction:column;gap:14px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px}
h1{font-size:19px;font-weight:650;margin:0;letter-spacing:-.01em}
.sub{color:var(--ink-2);font-size:13px}
.controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.label{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);margin-right:2px}
button{font:inherit;font-size:12.5px;color:var(--ink-2);background:var(--chip);border:1px solid transparent;
  border-radius:6px;padding:4px 11px;cursor:pointer}
button:hover{color:var(--ink)}
button:focus-visible,input:focus-visible,label:focus-within{outline:2px solid var(--sma);outline-offset:1px}
button[aria-pressed="true"]{background:var(--chip-on);color:var(--chip-on-ink)}
input[type=range]{flex:1;min-width:140px;accent-color:var(--sma)}
.chart-box{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:6px}
canvas{display:block;width:100%;height:460px;cursor:crosshair}
.tip{position:absolute;pointer-events:none;background:var(--tip);border:1px solid var(--line);border-radius:8px;
  padding:8px 11px;font-size:12.5px;display:none;box-shadow:0 4px 14px rgba(0,0,0,.14);max-width:250px;z-index:3}
.tip .d{font-weight:650;margin-bottom:3px}
.tip table{border-collapse:collapse;font-variant-numeric:tabular-nums}
.tip td{padding:0 0 1px;color:var(--ink-2)}
.tip td+td{padding-left:12px;text-align:right;color:var(--ink)}
.tip .pats{margin-top:5px;padding-top:5px;border-top:1px solid var(--line)}
.tip .pat{display:flex;gap:6px;align-items:baseline}
.tip .g{font-size:11px}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12.5px;color:var(--ink-2);padding:0 4px}
.legend .k{display:inline-flex;align-items:center;gap:6px}
.sw{width:14px;height:0;border-top:2px solid;display:inline-block}
.groups{display:flex;flex-direction:column;gap:8px}
.group{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;background:var(--chip);color:var(--ink-2);
  border-radius:15px;padding:3.5px 12px;cursor:pointer;user-select:none;border:1px solid transparent}
.chip input{position:absolute;opacity:0;pointer-events:none}
.chip .n{color:var(--ink-3);font-variant-numeric:tabular-nums;font-size:11.5px}
.chip.on{background:var(--chip-on);color:var(--chip-on-ink)}
.chip.on .n{color:var(--chip-on-ink);opacity:.65}
.mini{font-size:11px;padding:2px 8px;border-radius:12px}
details{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
summary{cursor:pointer;color:var(--ink-2);font-size:13px}
.tbl{overflow-x:auto;margin-top:8px}
table.data{border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums;width:100%}
table.data th{text-align:left;color:var(--ink-3);font-weight:550;padding:4px 14px 4px 0;border-bottom:1px solid var(--line)}
table.data td{padding:3px 14px 3px 0;border-bottom:1px solid var(--line);color:var(--ink-2);white-space:nowrap}
table.data td:first-child{color:var(--ink)}
</style>
<div class="wrap">
  <header>
    <h1>Pattern map</h1>
    <span class="sub" id="sub"></span>
  </header>
  <div class="controls" role="group" aria-label="Time range">
    <span class="label">Range</span>
    <button data-r="180">6M</button><button data-r="365" aria-pressed="true">1Y</button>
    <button data-r="730">2Y</button><button data-r="0">All</button>
    <span class="label" style="margin-left:10px">Pan</span>
    <input type="range" id="pan" min="0" max="1000" value="1000" aria-label="Pan through history">
  </div>
  <div class="chart-box">
    <canvas id="cv" role="img" aria-label="Candlestick chart with pattern markers; table view below"></canvas>
    <div class="tip" id="tip"></div>
  </div>
  <div class="legend">
    <span class="k"><span class="sw" style="border-color:var(--sma)"></span>SMA 50</span>
    <span class="k"><span class="sw" style="border-color:var(--ema)"></span>EMA 8</span>
    <span class="k" style="color:var(--up)">▲ bull pattern</span>
    <span class="k" style="color:var(--down)">▼ bear pattern</span>
    <span class="k">● context (rail below)</span>
  </div>
  <div class="groups" id="groups"></div>
  <details><summary>Table view — visible candles &amp; patterns</summary><div class="tbl" id="tblbox"></div></details>
</div>
<script>
const DATA = ${payload};
const C = DATA.candles, N = C.length;
const $ = (s) => document.querySelector(s);
const cv = $("#cv"), tip = $("#tip"), pan = $("#pan");
const NAME = {}; for (const m of DATA.meta) NAME[m.id] = m;
$("#sub").textContent = DATA.symbol + " · " + N + " candles · " + C[0].d + " → " + C[N-1].d;

const DEFAULT_ON = new Set(["three_white_soldiers","close_above_prev_high","inside_bar",
  "morning_star","bearish_engulfing","outside_bar_red"]);
const on = new Set(DEFAULT_ON);

// pattern toggle chips, grouped by direction
const groupsEl = $("#groups");
for (const dir of ["bull","bear","context"]) {
  const g = document.createElement("div"); g.className = "group";
  const lab = document.createElement("span"); lab.className = "label"; lab.textContent = dir; g.appendChild(lab);
  for (const m of DATA.meta.filter((m) => m.dir === dir)) {
    const chip = document.createElement("label");
    chip.className = "chip" + (on.has(m.id) ? " on" : "");
    chip.innerHTML = '<input type="checkbox"' + (on.has(m.id) ? " checked" : "") + '><span>' +
      m.name + '</span><span class="n">' + m.count + "</span>";
    chip.querySelector("input").addEventListener("change", (e) => {
      e.target.checked ? on.add(m.id) : on.delete(m.id);
      chip.classList.toggle("on", e.target.checked); draw();
    });
    g.appendChild(chip);
  }
  const all = document.createElement("button"); all.textContent = "all"; all.className = "mini";
  const none = document.createElement("button"); none.textContent = "none"; none.className = "mini";
  const setAll = (v) => { for (const m of DATA.meta.filter((m) => m.dir === dir)) {
    v ? on.add(m.id) : on.delete(m.id);
    } ; refreshChips(); draw(); };
  all.onclick = () => setAll(true); none.onclick = () => setAll(false);
  g.appendChild(all); g.appendChild(none);
  groupsEl.appendChild(g);
}
function refreshChips(){ for (const chip of groupsEl.querySelectorAll(".chip")) {
  const name = chip.querySelector("span").textContent;
  const m = DATA.meta.find((m) => m.name === name);
  const v = on.has(m.id);
  chip.classList.toggle("on", v); chip.querySelector("input").checked = v;
}}

// view window
let span = Math.min(365, N), end = N;
const start = () => Math.max(0, end - span);
function setSpan(s){ span = s === 0 ? N : Math.min(s, N); end = N; pan.value = 1000; draw(); }
document.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("[data-r]").forEach((x) => x.setAttribute("aria-pressed", x === b));
  setSpan(+b.dataset.r);
}));
pan.addEventListener("input", () => { end = Math.round(span + (N - span) * (pan.value / 1000)); draw(); });

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
let hoverI = -1;

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const x = cv.getContext("2d"); x.scale(dpr, dpr);
  const padL = 8, padR = 64, padT = 12, padB = 34, railH = 8;
  const s = start(), n = end - s;
  const plotW = W - padL - padR, plotH = H - padT - padB - railH;
  const step = plotW / n, cw = Math.max(1, Math.min(9, step * 0.65));
  let lo = Infinity, hi = -Infinity;
  for (let i = s; i < end; i++) { lo = Math.min(lo, C[i].l); hi = Math.max(hi, C[i].h); }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const X = (i) => padL + (i - s + 0.5) * step, Y = (p) => padT + (hi - p) / (hi - lo) * plotH;

  x.clearRect(0, 0, W, H);
  x.font = "11px ui-sans-serif,system-ui,sans-serif";
  // grid + y labels
  x.strokeStyle = css("--line"); x.fillStyle = css("--ink-3"); x.lineWidth = 1;
  const ticks = 5;
  for (let t = 0; t <= ticks; t++) {
    const p = lo + (hi - lo) * t / ticks, y = Y(p);
    x.beginPath(); x.moveTo(padL, y); x.lineTo(W - padR, y); x.stroke();
    x.fillText(p >= 1000 ? (p/1000).toFixed(1) + "k" : p.toFixed(0), W - padR + 8, y + 4);
  }
  // x labels
  const lblEvery = Math.ceil(n / 7);
  for (let i = s; i < end; i += lblEvery) x.fillText(C[i].d, Math.max(padL, X(i) - 24), H - padB + 16);

  // overlays
  for (const [arr, tok] of [[DATA.sma50, "--sma"], [DATA.ema8, "--ema"]]) {
    x.strokeStyle = css(tok); x.lineWidth = 2; x.beginPath();
    let started = false;
    for (let i = s; i < end; i++) {
      if (arr[i] === null) continue;
      const px = X(i), py = Y(arr[i]);
      started ? x.lineTo(px, py) : x.moveTo(px, py); started = true;
    }
    x.stroke();
    // direct label at line end
    for (let i = end - 1; i >= s; i--) if (arr[i] !== null) {
      x.fillStyle = css(tok);
      x.fillText(tok === "--sma" ? "SMA50" : "EMA8", W - padR + 8, Y(arr[i]) - 8 + (tok === "--ema" ? 16 : 0));
      break;
    }
  }

  // candles
  const up = css("--up"), down = css("--down");
  for (let i = s; i < end; i++) {
    const c = C[i], col = c.c >= c.o ? up : down, px = X(i);
    x.strokeStyle = col; x.lineWidth = 1;
    x.beginPath(); x.moveTo(px, Y(c.h)); x.lineTo(px, Y(c.l)); x.stroke();
    const yO = Y(c.o), yC = Y(c.c);
    x.fillStyle = col;
    x.fillRect(px - cw / 2, Math.min(yO, yC), cw, Math.max(1, Math.abs(yC - yO)));
  }

  // pattern markers
  const mk = Math.max(3.5, Math.min(6, step * 0.4));
  for (let i = s; i < end; i++) {
    const ids = DATA.fired[i].filter((id) => on.has(id));
    if (!ids.length) continue;
    const px = X(i);
    let upStack = 0, dnStack = 0, hasCtx = false;
    for (const id of ids) {
      const dir = NAME[id].dir;
      if (dir === "bull") {
        const y = Y(C[i].l) + 8 + upStack * (mk * 2 + 2); upStack++;
        x.fillStyle = up; x.beginPath();
        x.moveTo(px, y); x.lineTo(px - mk, y + mk * 1.6); x.lineTo(px + mk, y + mk * 1.6); x.fill();
      } else if (dir === "bear") {
        const y = Y(C[i].h) - 8 - dnStack * (mk * 2 + 2); dnStack++;
        x.fillStyle = down; x.beginPath();
        x.moveTo(px, y); x.lineTo(px - mk, y - mk * 1.6); x.lineTo(px + mk, y - mk * 1.6); x.fill();
      } else hasCtx = true;
    }
    if (hasCtx) {
      x.fillStyle = css("--ink-3");
      x.beginPath(); x.arc(px, padT + plotH + railH, 2.2, 0, 7); x.fill();
    }
  }

  // crosshair
  if (hoverI >= s && hoverI < end) {
    x.strokeStyle = css("--ink-3"); x.setLineDash([4, 4]);
    x.beginPath(); x.moveTo(X(hoverI), padT); x.lineTo(X(hoverI), padT + plotH + railH); x.stroke();
    x.setLineDash([]);
  }
  draw._geom = { X, s, step, padL, padR };
  renderTable();
}

function renderTable() {
  const box = $("#tblbox");
  if (!box.closest("details").open) { box.dataset.stale = "1"; return; }
  const s = start();
  let h = "<table class='data'><tr><th>Date</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Patterns firing</th></tr>";
  for (let i = s; i < end; i++) {
    const ids = DATA.fired[i].filter((id) => on.has(id));
    if (!ids.length) continue;
    const c = C[i];
    h += "<tr><td>" + c.d + "</td><td>" + c.o + "</td><td>" + c.h + "</td><td>" + c.l + "</td><td>" + c.c +
      "</td><td>" + ids.map((id) => NAME[id].name).join(", ") + "</td></tr>";
  }
  box.innerHTML = h + "</table>";
}
document.querySelector("details").addEventListener("toggle", renderTable);

cv.addEventListener("mousemove", (e) => {
  const g = draw._geom; if (!g) return;
  const r = cv.getBoundingClientRect();
  const i = Math.min(end - 1, Math.max(g.s, g.s + Math.floor((e.clientX - r.left - g.padL) / g.step)));
  if (i !== hoverI) { hoverI = i; draw(); }
  const c = C[i], chg = ((c.c - c.o) / c.o * 100);
  const ids = DATA.fired[i].filter((id) => on.has(id));
  tip.style.display = "block";
  tip.innerHTML = "<div class='d'>" + c.d + "</div><table>" +
    "<tr><td>Open</td><td>" + c.o + "</td></tr><tr><td>High</td><td>" + c.h + "</td></tr>" +
    "<tr><td>Low</td><td>" + c.l + "</td></tr><tr><td>Close</td><td>" + c.c +
    " (" + (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%)</td></tr></table>" +
    (ids.length ? "<div class='pats'>" + ids.map((id) => {
      const m = NAME[id], g2 = m.dir === "bull" ? "▲" : m.dir === "bear" ? "▼" : "●";
      const col = m.dir === "bull" ? "var(--up)" : m.dir === "bear" ? "var(--down)" : "var(--ink-3)";
      return "<div class='pat'><span class='g' style='color:" + col + "'>" + g2 + "</span>" + m.name + "</div>";
    }).join("") + "</div>" : "");
  const tx = e.clientX - r.left, half = r.width / 2;
  tip.style.left = tx < half ? (tx + 18) + "px" : "auto";
  tip.style.right = tx < half ? "auto" : (r.width - tx + 18) + "px";
  tip.style.top = Math.min(e.clientY - r.top + 14, r.height - tip.offsetHeight - 10) + "px";
});
cv.addEventListener("mouseleave", () => { hoverI = -1; tip.style.display = "none"; draw(); });

new ResizeObserver(() => draw()).observe(cv);
new MutationObserver(() => draw()).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => draw());
draw();
</script>`;

writeFileSync(out, html);
console.log(`Wrote ${out} — ${candles.length} candles, ${meta.reduce((s, m) => s + m.count, 0)} pattern hits across ${meta.length} patterns`);
