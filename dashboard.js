/**
 * Generates a local HTML dashboard summarizing the bot's state.
 * Supports multiple symbols — shows a card per symbol.
 *
 * Run with: node dashboard.js          (writes dashboard.html once, opens it)
 *       or: node dashboard.js --serve  (live server, auto-refreshes every 30s)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { createServer } from "http";
import { CONFIG, signBitGet, fetchCandles } from "./bot.js";

const REFRESH_SECONDS = 30;
const SERVE_PORT = process.env.DASHBOARD_PORT || 4787;
const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,SOLUSDT").split(",");

// ── Per-symbol file helpers ────────────────────────────────────────────────────
function logFile(sym)       { return `safety-check-log-${sym}.json`; }
function positionFile(sym)  { return `position-${sym}.json`; }
function portfolioFile(sym) { return `portfolio-${sym}.json`; }
function csvFile(sym)       { return `trades-${sym}.csv`; }

function loadPositionFor(sym) {
  const f = positionFile(sym);
  if (!existsSync(f)) return null;
  const raw = JSON.parse(readFileSync(f, "utf8"));
  return raw === null ? null : raw;
}

function loadPortfolioFor(sym) {
  const f = portfolioFile(sym);
  if (!existsSync(f)) return 1000;
  return JSON.parse(readFileSync(f, "utf8")).value ?? 1000;
}

function computeStats(sym) {
  const f = logFile(sym);
  if (!existsSync(f)) return { entryCount: 0, exitCount: 0, wins: 0, winRate: null, totalPnlUSD: 0, tradesPerDay: null };
  const log = JSON.parse(readFileSync(f, "utf8"));
  const entries = log.trades.filter(t => t.type === "entry" && t.orderPlaced);
  const exits   = log.trades.filter(t => t.type === "exit"  && t.orderPlaced);
  const stops   = log.trades.filter(t => t.type === "stop");
  const allClosed = [...exits, ...stops];
  const wins = allClosed.filter(e => (e.pnlUSD ?? 0) > 0).length;
  const winRate = allClosed.length > 0 ? (wins / allClosed.length) * 100 : null;
  const totalPnlUSD = allClosed.reduce((s, e) => s + (e.pnlUSD ?? 0), 0);
  let tradesPerDay = null;
  if (entries.length > 0) {
    const firstTs = new Date(entries[0].timestamp).getTime();
    const daysActive = Math.max((Date.now() - firstTs) / 86400000, 1 / 24);
    tradesPerDay = entries.length / daysActive;
  }
  return { entryCount: entries.length, exitCount: allClosed.length, wins, winRate, totalPnlUSD, tradesPerDay };
}

function readRecentTrades(sym, limit = 10) {
  // Read from the JSON log (catches all trade types including stops and entries)
  const f = logFile(sym);
  if (!existsSync(f)) return [];
  const log = JSON.parse(readFileSync(f, "utf8"));
  return (log.trades || [])
    .filter(t => ["entry","exit","stop","pyramid"].includes(t.type))
    .slice(-limit)
    .reverse();
}

// ── Shared helpers ─────────────────────────────────────────────────────────────
async function fetchBalance() {
  const timestamp = Date.now().toString();
  const path = CONFIG.tradeMode === "futures"
    ? "/api/v2/mix/account/accounts?productType=USDT-FUTURES"
    : "/api/v2/spot/account/assets";
  const signature = signBitGet(timestamp, "GET", path, "");
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
  });
  const body = await res.json();
  if (body.code !== "00000") throw new Error(`BitGet balance error: ${body.msg}`);
  return body.data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function toEastern(utcDate) {
  const date = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(utcDate);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true }).format(utcDate);
  return { date, time };
}

// ── Per-symbol card ────────────────────────────────────────────────────────────
async function buildSymbolCard(sym) {
  const stats     = computeStats(sym);
  const portfolio = loadPortfolioFor(sym);
  const position  = loadPositionFor(sym);
  const startVal  = 1000;
  const totalPct  = ((portfolio - startVal) / startVal * 100).toFixed(2);
  const pnlClass  = portfolio >= startVal ? "pos" : "neg";

  // Position HTML
  let posHtml;
  if (position) {
    let currentPrice = null;
    try {
      const c = await fetchCandles(sym, "15m", 5);
      currentPrice = c[c.length - 1].close;
    } catch {}
    const pnlUSD = currentPrice === null ? null
      : position.side === "long"
        ? (currentPrice - position.entryPrice) * position.quantity
        : (position.entryPrice - currentPrice) * position.quantity;
    const pnlPct = pnlUSD === null ? null : (pnlUSD / position.sizeUSD) * 100;
    const { date, time } = toEastern(new Date(position.openedAt));
    posHtml = `
      <div class="stat"><span>Side</span><strong>${position.side.toUpperCase()}</strong></div>
      <div class="stat"><span>Entry</span><strong>$${position.entryPrice.toFixed(2)}</strong></div>
      <div class="stat"><span>Current</span><strong>${currentPrice !== null ? "$" + currentPrice.toFixed(2) : "N/A"}</strong></div>
      <div class="stat"><span>Size</span><strong>$${(position.sizeUSD ?? 0).toFixed(2)}</strong></div>
      <div class="stat"><span>Unrealized P&amp;L</span><strong class="${pnlUSD !== null && pnlUSD >= 0 ? "pos" : "neg"}">${pnlUSD !== null ? `$${pnlUSD.toFixed(2)} (${pnlPct.toFixed(2)}%)` : "N/A"}</strong></div>
      <div class="stat"><span>Stop</span><strong>$${position.stopLossPrice != null ? position.stopLossPrice.toFixed(2) : "N/A"}</strong></div>
      <div class="stat"><span>Pyramids</span><strong>${position.pyramided ?? 0} / 3</strong></div>
      <div class="stat"><span>Opened</span><strong>${date} ${time} ET</strong></div>`;
  } else {
    posHtml = `<div class="empty">No open position</div>`;
  }

  // Trades HTML
  const trades = readRecentTrades(sym);
  const tradesHtml = trades.length
    ? `<table>
        <tr><th>Time (ET)</th><th>Type</th><th>Side</th><th>Price</th><th>Size USD</th><th>P&amp;L</th></tr>
        ${trades.map(t => {
          const { date, time } = toEastern(new Date(t.timestamp));
          const typeColor = t.type === "stop" ? "neg" : t.type === "entry" ? "" : t.type === "pyramid" ? "pos" : "pos";
          const pnl = t.pnlUSD != null ? `<span class="${t.pnlUSD >= 0 ? "pos" : "neg"}">${t.pnlUSD >= 0 ? "+" : ""}$${t.pnlUSD.toFixed(2)}</span>` : "—";
          return `<tr>
            <td>${escapeHtml(date)} ${escapeHtml(time)}</td>
            <td class="${typeColor}">${escapeHtml(t.type.toUpperCase())}</td>
            <td>${escapeHtml((t.side || "").toUpperCase())}</td>
            <td>${t.price != null ? "$" + escapeHtml(t.price.toFixed(2)) : "—"}</td>
            <td>${t.sizeUSD != null ? "$" + escapeHtml(t.sizeUSD.toFixed(2)) : "—"}</td>
            <td>${pnl}</td>
          </tr>`;
        }).join("")}
      </table>`
    : `<div class="empty">No trades logged yet</div>`;

  return `
  <div class="symbol-section">
    <div class="symbol-header">
      <span class="symbol-name">${escapeHtml(sym)}</span>
      <span class="badge badge-paper">PAPER</span>
    </div>

    <div class="cards-row">
      <div class="card">
        <h2>Portfolio</h2>
        <div class="stat"><span>Value</span><strong>$${portfolio.toFixed(2)}</strong></div>
        <div class="stat"><span>Return</span><strong class="${pnlClass}">${totalPct >= 0 ? "+" : ""}${totalPct}%</strong></div>
        <div class="stat"><span>Closed trades</span><strong>${stats.exitCount}</strong></div>
        <div class="stat"><span>Win rate</span><strong>${stats.winRate !== null ? stats.winRate.toFixed(1) + "%" : "—"}</strong></div>
        <div class="stat"><span>Total P&amp;L</span><strong class="${stats.totalPnlUSD >= 0 ? "pos" : "neg"}">${stats.exitCount > 0 ? (stats.totalPnlUSD >= 0 ? "+" : "") + "$" + stats.totalPnlUSD.toFixed(2) : "—"}</strong></div>
        <div class="stat"><span>Trade freq</span><strong>${stats.tradesPerDay !== null ? stats.tradesPerDay.toFixed(1) + " / day" : "—"}</strong></div>
      </div>

      <div class="card">
        <h2>Open Position</h2>
        ${posHtml}
      </div>
    </div>

    <div class="card">
      <h2>Recent Trades — ${escapeHtml(sym)}</h2>
      ${tradesHtml}
    </div>
  </div>`;
}

// ── Main HTML builder ─────────────────────────────────────────────────────────
async function buildDashboardHtml() {
  let balanceHtml;
  try {
    const data = await fetchBalance();
    if (CONFIG.tradeMode === "futures") {
      balanceHtml = `<pre style="font-size:12px;color:#aaa;overflow:auto">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
    } else {
      const usdt = data.find(a => a.coin === "USDT");
      const bal = usdt ? parseFloat(usdt.available) + parseFloat(usdt.frozen) : 0;
      balanceHtml = `<div class="stat"><span>USDT balance</span><strong>$${bal.toFixed(2)}</strong></div>`;
    }
  } catch (err) {
    balanceHtml = `<div class="error">Could not fetch live balance: ${escapeHtml(err.message)}</div>`;
  }

  const symbolCards = await Promise.all(SYMBOLS.map(buildSymbolCard));
  const { date, time } = toEastern(new Date());

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<title>Trading Bot Dashboard</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; background: #0f1115; color: #e6e6e6; margin: 0; padding: 24px 32px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: #888; margin-bottom: 28px; font-size: 13px; }
  .card { background: #1a1d24; border: 1px solid #2a2e38; border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #999; margin: 0 0 12px; }
  .stat { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px solid #23262e; font-size: 14px; }
  .stat:last-child { border-bottom: none; }
  .stat span { color: #999; }
  .pos { color: #4ade80; }
  .neg { color: #f87171; }
  .empty { color: #777; font-style: italic; font-size: 13px; }
  .error { color: #f87171; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 7px 5px; border-bottom: 1px solid #23262e; }
  th { color: #999; font-weight: 500; }
  .mode-paper { color: #60a5fa; }
  .mode-live { color: #4ade80; }
  .mode-blocked { color: #888; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
  .badge-paper { background: #1e3a5f; color: #60a5fa; }
  .badge-live { background: #1e3a2a; color: #4ade80; }
  .symbol-section { margin-bottom: 36px; }
  .symbol-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
  .symbol-name { font-size: 18px; font-weight: 700; letter-spacing: 0.03em; }
  .cards-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  hr { border: none; border-top: 1px solid #2a2e38; margin: 32px 0; }
</style>
</head>
<body>
  <h1>Claude Trading Bot</h1>
  <div class="subtitle">Generated ${date} ${time} ET · Strategy: NKB + ADX + Trail 3×ATR + Pyramid 3× + 4H MTF · 15m · Paper</div>

  <div class="card" style="margin-bottom:28px">
    <h2>BitGet Account</h2>
    ${balanceHtml}
  </div>

  ${symbolCards.join('<hr>')}
</body>
</html>`;
}

// ── Output modes ─────────────────────────────────────────────────────────────
async function writeOnce() {
  console.log("Building dashboard...");
  const html = await buildDashboardHtml();
  writeFileSync("dashboard.html", html);
  console.log("Dashboard written to dashboard.html");
  if (!process.argv.includes("--no-open")) {
    try { execSync("start dashboard.html"); } catch {
      try { execSync("open dashboard.html"); } catch {}
    }
  }
}

function serve() {
  const server = createServer(async (req, res) => {
    try {
      const html = await buildDashboardHtml();
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Dashboard error: ${err.message}`);
    }
  });
  server.listen(SERVE_PORT, () => {
    console.log(`Live dashboard at http://localhost:${SERVE_PORT} (refreshes every ${REFRESH_SECONDS}s)`);
    if (!process.argv.includes("--no-open")) {
      try { execSync(`start http://localhost:${SERVE_PORT}`); } catch {
        try { execSync(`open http://localhost:${SERVE_PORT}`); } catch {}
      }
    }
  });
}

if (process.argv.includes("--serve")) {
  serve();
} else {
  writeOnce().catch(err => { console.error("Dashboard error:", err); process.exit(1); });
}
