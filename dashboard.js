/**
 * Generates a local HTML dashboard summarizing the bot's state:
 * live BitGet account balance, current open position (if any), and
 * recent trade history.
 *
 * Run with: node dashboard.js          (writes dashboard.html once, opens it)
 *       or: node dashboard.js --serve  (live server, auto-refreshes every 30s)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { createServer } from "http";
import { CONFIG, signBitGet, fetchCandles, loadPosition, CSV_FILE, LOG_FILE } from "./bot.js";

const REFRESH_SECONDS = 30;
const SERVE_PORT = process.env.DASHBOARD_PORT || 4787;

async function fetchBalance() {
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "futures"
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
  if (body.code !== "00000") {
    throw new Error(`BitGet balance error: ${body.msg}`);
  }
  return body.data;
}

function summarizeSpotBalance(assets) {
  const usdt = assets.find((a) => a.coin === "USDT");
  const usdtTotal = usdt
    ? parseFloat(usdt.available) + parseFloat(usdt.frozen) + parseFloat(usdt.locked)
    : 0;
  const otherHoldings = assets
    .filter((a) => a.coin !== "USDT" && parseFloat(a.available) + parseFloat(a.frozen) > 0)
    .map((a) => ({ coin: a.coin, amount: parseFloat(a.available) + parseFloat(a.frozen) }));
  return { usdtTotal, otherHoldings };
}

function computePerformanceStats() {
  if (!existsSync(LOG_FILE)) {
    return { entryCount: 0, exitCount: 0, winRate: null, totalPnlUSD: 0, tradesPerDay: null };
  }
  const log = JSON.parse(readFileSync(LOG_FILE, "utf8"));
  const entries = log.trades.filter((t) => t.type === "entry" && t.orderPlaced);
  const exits = log.trades.filter((t) => t.type === "exit" && t.orderPlaced);

  const wins = exits.filter((e) => e.pnlUSD > 0).length;
  const winRate = exits.length > 0 ? (wins / exits.length) * 100 : null;
  const totalPnlUSD = exits.reduce((sum, e) => sum + e.pnlUSD, 0);

  let tradesPerDay = null;
  if (entries.length > 0) {
    const firstTs = new Date(entries[0].timestamp).getTime();
    const daysActive = Math.max((Date.now() - firstTs) / 86400000, 1 / 24);
    tradesPerDay = entries.length / daysActive;
  }

  return { entryCount: entries.length, exitCount: exits.length, wins, winRate, totalPnlUSD, tradesPerDay };
}

function readRecentTrades(limit = 10) {
  if (!existsSync(CSV_FILE)) return [];
  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines
    .slice(1) // header
    .map((l) => l.split(","))
    .filter((r) => r[0] !== ""); // skip the funny note row
  return rows.slice(-limit).reverse();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function buildDashboardHtml() {
  const stats = computePerformanceStats();

  let balanceHtml;
  try {
    const data = await fetchBalance();
    if (CONFIG.tradeMode === "spot") {
      const { usdtTotal, otherHoldings } = summarizeSpotBalance(data);
      balanceHtml = `
        <div class="stat"><span>USDT balance</span><strong>$${usdtTotal.toFixed(2)}</strong></div>
        ${otherHoldings.length ? `<div class="stat"><span>Other holdings</span><strong>${otherHoldings.map((h) => `${h.amount} ${h.coin}`).join(", ")}</strong></div>` : ""}
      `;
    } else {
      balanceHtml = `<pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
    }
  } catch (err) {
    balanceHtml = `<div class="error">Could not fetch live balance: ${escapeHtml(err.message)}</div>`;
  }

  const position = loadPosition();
  let positionHtml;
  if (position) {
    let currentPrice = null;
    try {
      const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 5);
      currentPrice = candles[candles.length - 1].close;
    } catch {}

    const pnlUSD =
      currentPrice === null
        ? null
        : position.side === "long"
          ? (currentPrice - position.entryPrice) * position.quantity
          : (position.entryPrice - currentPrice) * position.quantity;
    const pnlPct = pnlUSD === null ? null : (pnlUSD / position.sizeUSD) * 100;

    const stopLossPrice =
      position.side === "long"
        ? position.entryPrice * (1 - CONFIG.stopLossPct / 100)
        : position.entryPrice * (1 + CONFIG.stopLossPct / 100);
    const trailingStopPrice =
      position.side === "long"
        ? position.extremePrice * (1 - CONFIG.trailingStopPct / 100)
        : position.extremePrice * (1 + CONFIG.trailingStopPct / 100);

    positionHtml = `
      <div class="stat"><span>Side</span><strong>${position.side.toUpperCase()}</strong></div>
      <div class="stat"><span>Entry price</span><strong>$${position.entryPrice.toFixed(2)}</strong></div>
      <div class="stat"><span>Current price</span><strong>${currentPrice !== null ? "$" + currentPrice.toFixed(2) : "N/A"}</strong></div>
      <div class="stat"><span>Quantity</span><strong>${position.quantity}</strong></div>
      <div class="stat"><span>Size (USD)</span><strong>$${position.sizeUSD.toFixed(2)}</strong></div>
      <div class="stat"><span>Unrealized P&amp;L</span><strong class="${pnlUSD >= 0 ? "pos" : "neg"}">${pnlUSD !== null ? `$${pnlUSD.toFixed(2)} (${pnlPct.toFixed(2)}%)` : "N/A"}</strong></div>
      <div class="stat"><span>Stop loss</span><strong>$${stopLossPrice.toFixed(2)}</strong></div>
      <div class="stat"><span>Trailing stop</span><strong>$${trailingStopPrice.toFixed(2)}</strong></div>
      <div class="stat"><span>Opened</span><strong>${position.openedAt}</strong></div>
    `;
  } else {
    positionHtml = `<div class="empty">No open position</div>`;
  }

  const trades = readRecentTrades(10);
  const tradesHtml = trades.length
    ? `
      <table>
        <tr><th>Date</th><th>Time</th><th>Side</th><th>Qty</th><th>Price</th><th>Total USD</th><th>Mode</th><th>Notes</th></tr>
        ${trades
          .map(
            (r) => `
          <tr>
            <td>${escapeHtml(r[0])}</td>
            <td>${escapeHtml(r[1])}</td>
            <td>${escapeHtml(r[4])}</td>
            <td>${escapeHtml(r[5])}</td>
            <td>${escapeHtml(r[6])}</td>
            <td>${escapeHtml(r[7])}</td>
            <td class="mode-${escapeHtml((r[11] || "").toLowerCase())}">${escapeHtml(r[11])}</td>
            <td>${escapeHtml(r[12] || "").replace(/^"|"$/g, "")}</td>
          </tr>`,
          )
          .join("")}
      </table>
    `
    : `<div class="empty">No trades logged yet</div>`;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<title>Trading Bot Dashboard</title>
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; background: #0f1115; color: #e6e6e6; margin: 0; padding: 32px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: #888; margin-bottom: 28px; font-size: 13px; }
  .card { background: #1a1d24; border: 1px solid #2a2e38; border-radius: 10px; padding: 20px; margin-bottom: 20px; }
  .card h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: #999; margin: 0 0 14px; }
  .stat { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #23262e; font-size: 14px; }
  .stat:last-child { border-bottom: none; }
  .stat span { color: #999; }
  .pos { color: #4ade80; }
  .neg { color: #f87171; }
  .empty { color: #777; font-style: italic; }
  .error { color: #f87171; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #23262e; }
  th { color: #999; font-weight: 500; }
  .mode-paper { color: #60a5fa; }
  .mode-live { color: #4ade80; }
  .mode-blocked { color: #888; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
  .badge-paper { background: #1e3a5f; color: #60a5fa; }
  .badge-live { background: #1e3a2a; color: #4ade80; }
</style>
</head>
<body>
  <h1>Claude Trading Bot — ${escapeHtml(CONFIG.symbol)} <span class="badge ${CONFIG.paperTrading ? "badge-paper" : "badge-live"}">${CONFIG.paperTrading ? "PAPER" : "LIVE"}</span></h1>
  <div class="subtitle">Generated ${new Date().toISOString()} · Strategy: VWAP + RSI(3) + EMA(8) · Timeframe: ${escapeHtml(CONFIG.timeframe)}</div>

  <div class="card">
    <h2>Account</h2>
    ${balanceHtml}
    <div class="stat"><span>Configured portfolio value</span><strong>$${CONFIG.portfolioValue.toFixed(2)}</strong></div>
    <div class="stat"><span>Max trade size</span><strong>$${CONFIG.maxTradeSizeUSD.toFixed(2)}</strong></div>
    <div class="stat"><span>Max trades / day</span><strong>${CONFIG.maxTradesPerDay === 0 ? "No limit" : CONFIG.maxTradesPerDay}</strong></div>
    <div class="stat"><span>Trade frequency</span><strong>${stats.tradesPerDay !== null ? `${stats.tradesPerDay.toFixed(2)} / day (${stats.entryCount} opened total)` : "No trades opened yet"}</strong></div>
    <div class="stat"><span>Total P&amp;L (closed trades)</span><strong class="${stats.totalPnlUSD >= 0 ? "pos" : "neg"}">${stats.exitCount > 0 ? `$${stats.totalPnlUSD.toFixed(2)}` : "No closed trades yet"}</strong></div>
    <div class="stat"><span>Trade accuracy</span><strong>${stats.winRate !== null ? `${stats.winRate.toFixed(1)}% (${stats.wins}/${stats.exitCount} wins)` : "No closed trades yet"}</strong></div>
  </div>

  <div class="card">
    <h2>Current Position</h2>
    ${positionHtml}
  </div>

  <div class="card">
    <h2>Recent Trades</h2>
    ${tradesHtml}
  </div>
</body>
</html>`;

  return html;
}

async function writeOnce() {
  console.log("Fetching live BitGet balance and current position...");
  const html = await buildDashboardHtml();
  writeFileSync("dashboard.html", html);
  console.log("Dashboard written to dashboard.html");

  if (!process.argv.includes("--no-open")) {
    try {
      execSync("start dashboard.html");
    } catch {
      try {
        execSync("open dashboard.html");
      } catch {}
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
      try {
        execSync(`start http://localhost:${SERVE_PORT}`);
      } catch {
        try {
          execSync(`open http://localhost:${SERVE_PORT}`);
        } catch {}
      }
    }
  });
}

if (process.argv.includes("--serve")) {
  serve();
} else {
  writeOnce().catch((err) => {
    console.error("Dashboard error:", err);
    process.exit(1);
  });
}
