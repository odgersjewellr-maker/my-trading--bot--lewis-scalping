/**
 * NKB Webhook Server
 *
 * TradingView fires an alert → POSTs to this server → executes instantly.
 * Reads/writes state via GitHub API so it stays in sync with the cron bot.
 *
 * GET /dashboard?key=<WEBHOOK_SECRET> — live account/position/trades dashboard.
 *
 * Required Railway env vars:
 *   BITGET_API_KEY, BITGET_SECRET_KEY, BITGET_PASSPHRASE
 *   GITHUB_TOKEN   — personal access token with repo write scope
 *   GITHUB_REPO    — e.g. odgersjewellr-maker/my-trading--bot--lewis-scalping
 *   WEBHOOK_SECRET — any password you choose (must match TradingView alert header)
 *   PAPER_TRADING=true
 *   TRADE_MODE=futures
 *   LEVERAGE=1      — futures only; explicitly set via API, never left to the account default
 *   TRADE_SIZE_PCT=80 — % of current portfolio value risked per trade, recalculated every trade
 *   SYMBOL=BTCUSDT
 *   TIMEFRAME=5m
 *   PORTFOLIO_VALUE_USD=640
 */

import "dotenv/config";
import { createServer } from "http";
import crypto from "crypto";
import { CONFIG, fetchCandles, signBitGet, computeStopLossPrice, setLeverage } from "./bot.js";

const PORT            = process.env.PORT || 3000;
const WEBHOOK_SECRET  = process.env.WEBHOOK_SECRET || "";
const GITHUB_TOKEN    = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO     = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH   = "main";
const GITHUB_API      = "https://api.github.com";

// ─── GitHub state store ───────────────────────────────────────────────────────
// All state is persisted to GitHub so the cron bot and webhook server share it.

async function ghGet(path) {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status}`);
  return res.json();
}

async function ghPut(path, content, message, sha) {
  const body = JSON.stringify({
    message,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
    branch: GITHUB_BRANCH,
    ...(sha && { sha }),
  });
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub PUT ${path} failed: ${res.status} ${err}`);
  }
  return res.json();
}

async function loadState(filename) {
  const file = await ghGet(filename);
  if (!file) return null;
  return { data: JSON.parse(Buffer.from(file.content, "base64").toString()), sha: file.sha };
}

async function saveState(filename, data, sha) {
  return ghPut(filename, data, `Webhook: update ${filename}`, sha);
}

// trades.csv is plain text, not JSON — loadState() always JSON.parse()s, so it needs its own reader.
async function loadRawText(filename) {
  const file = await ghGet(filename);
  if (!file) return null;
  return Buffer.from(file.content, "base64").toString();
}

// Appends one row to trades.csv on GitHub. Mirrors bot.js's writeCsvRow() format/columns —
// the webhook path executes most trades these days, so without this the CSV (and the
// dashboard's "Recent trades" table, which reads it) goes stale even though trading continues.
async function appendCsvRow({ side, quantity, price, totalUSD, orderId, mode, notes }) {
  const file = await ghGet("trades.csv");
  const existing = file ? Buffer.from(file.content, "base64").toString() : "";
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);
  const fee = totalUSD !== undefined ? (totalUSD * 0.001).toFixed(4) : "";
  const netAmount = totalUSD !== undefined ? (totalUSD - parseFloat(fee)).toFixed(2) : "";
  const row = [
    date, time, "BitGet", CONFIG.symbol, side ?? "", quantity ?? "",
    price !== undefined ? price.toFixed(2) : "",
    totalUSD !== undefined ? totalUSD.toFixed(2) : "",
    fee, netAmount, orderId ?? "", mode, `"${notes}"`,
  ].join(",");
  const updated = existing && !existing.endsWith("\n") ? `${existing}\n${row}\n` : `${existing}${row}\n`;
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/trades.csv`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "Webhook: append trades.csv row",
      content: Buffer.from(updated).toString("base64"),
      branch: GITHUB_BRANCH,
      ...(file && { sha: file.sha }),
    }),
  });
  if (!res.ok) {
    console.log(`⚠️ Failed to append trades.csv row: ${res.status} ${await res.text()}`);
  }
}

// ─── BitGet order execution ───────────────────────────────────────────────────

async function executeOrder(side, quantity, stopLossPrice, positionSide) {
  if (CONFIG.paperTrading) return { orderId: `PAPER-${Date.now()}`, paper: true };

  if (CONFIG.tradeMode === "futures" && positionSide) {
    await setLeverage(CONFIG.symbol, positionSide);
  }

  const qty  = parseFloat(quantity).toFixed(6);
  const ts   = Date.now().toString();
  const path = "/api/v2/mix/order/placeOrder";
  const body = JSON.stringify({
    symbol: CONFIG.symbol,
    side,
    orderType: "market",
    quantity: qty,
    productType: "USDT-FUTURES",
    marginMode: "isolated",
    marginCoin: "USDT",
    ...(stopLossPrice && { presetStopLossPrice: stopLossPrice.toFixed(2) }),
  });
  const sig = signBitGet(ts, "POST", path, body);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": sig,
      "ACCESS-TIMESTAMP": ts,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });
  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet order failed: ${data.msg}`);
  return { orderId: data.data.orderId, paper: false };
}

// ─── Trade execution ──────────────────────────────────────────────────────────

// executeTrade reads each GitHub state file's sha then writes back with it.
// Two overlapping calls (e.g. several TradingView alerts firing close
// together) would race on the same files — the second write's sha goes
// stale and GitHub rejects it (409), silently dropping that signal partway
// through. Queue calls so only one runs at a time.
let tradeQueue = Promise.resolve();
function queueTrade(signal) {
  const result = tradeQueue.then(() => executeTrade(signal));
  tradeQueue = result.catch(() => {});
  return result;
}

async function executeTrade(signal) {
  const log = [];
  const out = (msg) => { console.log(msg); log.push(msg); };

  out(`\n[${new Date().toISOString()}] Webhook: ${signal}`);

  // Fetch candles and price
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 10);
  const price   = candles[candles.length - 1].close;
  out(`Price: $${price.toFixed(2)}`);

  // Load all state from GitHub (symbol-prefixed files)
  const sym = CONFIG.symbol;
  const [posFile, portFile, stateFile, logFile] = await Promise.all([
    loadState(`position-${sym}.json`),
    loadState(`portfolio-${sym}.json`),
    loadState(`nkb-state-${sym}.json`),
    loadState(`safety-check-log-${sym}.json`),
  ]);

  let position      = posFile?.data ?? null;
  let portfolioValue = portFile?.data?.value ?? CONFIG.portfolioValue;
  const prevNKBState = stateFile?.data?.state ?? 0;
  const tradeLog     = logFile?.data ?? { trades: [] };

  // Active hours filter: 08:00–20:00 UTC only
  const utcHour = new Date().getUTCHours();
  if (utcHour < 8 || utcHour >= 20) {
    out(`Outside active hours (UTC ${utcHour}:xx) — signal ignored`);
    return log.join("\n");
  }

  const buySignal  = signal === "BUY";
  const sellSignal = signal === "SELL";

  // Save new NKB state
  const newNKBState = buySignal ? 1 : -1;
  await saveState(`nkb-state-${sym}.json`,
    { state: newNKBState, updatedAt: new Date().toISOString() },
    stateFile?.sha
  );

  // Check for duplicate signal (already in the right direction)
  if (position) {
    const alreadyCorrect = (buySignal && position.side === "long") || (sellSignal && position.side === "short");
    if (alreadyCorrect) {
      out(`Already in ${position.side} — signal matches, holding`);
      return log.join("\n");
    }

    // Close existing position (reversal)
    const closeSide = position.side === "long" ? "sell" : "buy";
    const pnlUSD = position.side === "long"
      ? (price - position.entryPrice) * position.quantity
      : (position.entryPrice - price) * position.quantity;
    const pnlPct = (pnlUSD / position.sizeUSD) * 100;

    out(`Closing ${position.side} — P&L $${pnlUSD.toFixed(2)} (${pnlPct.toFixed(2)}%)`);

    let closeOrder;
    try {
      closeOrder = await executeOrder(closeSide, position.quantity);
    } catch (err) {
      out(`❌ Close failed: ${err.message}`);
      return log.join("\n");
    }

    portfolioValue += pnlUSD;
    const closedQuantity = position.quantity;
    const closedSizeUSD = position.sizeUSD;
    tradeLog.trades.push({
      timestamp: new Date().toISOString(), type: "exit", symbol: CONFIG.symbol,
      side: closeSide, quantity: closedQuantity, price, sizeUSD: closedSizeUSD,
      pnlUSD, pnlPct, reason: "NKB webhook reversal", orderPlaced: true,
      orderId: closeOrder.orderId, paperTrading: CONFIG.paperTrading,
    });

    // Each saveState() creates its own commit on the same branch — running
    // these in parallel makes them race for the branch HEAD, so the 2nd/3rd
    // commit gets rejected with a 409 (confirmed in Railway logs: GitHub
    // returned the just-created sibling commit's sha as the conflict).
    // They must run sequentially, one commit at a time.
    await saveState(`portfolio-${sym}.json`, { value: portfolioValue, updatedAt: new Date().toISOString() }, portFile?.sha);
    await saveState(`position-${sym}.json`, null, posFile?.sha);
    await saveState(`safety-check-log-${sym}.json`, tradeLog, logFile?.sha);
    position = null;
    out(`Portfolio: $${portfolioValue.toFixed(2)}`);

    await appendCsvRow({
      side: closeSide.toUpperCase(), quantity: closedQuantity, price, totalUSD: closedSizeUSD,
      orderId: closeOrder.orderId, mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
      notes: `NKB reversal exit — P&L $${pnlUSD.toFixed(2)} (${pnlPct.toFixed(2)}%) | Portfolio: $${portfolioValue.toFixed(2)}`,
    });
  }

  // Open new position
  const canShort   = CONFIG.tradeMode === "futures";
  if (sellSignal && !canShort) {
    out("SELL signal — spot mode, can't short. Staying flat.");
    return log.join("\n");
  }

  const tradeSize   = portfolioValue * CONFIG.tradeSizePct;
  const side        = buySignal ? "buy" : "sell";
  const positionSide = buySignal ? "long" : "short";
  const quantity    = parseFloat((tradeSize / price).toFixed(6));
  const stopLossPrice = computeStopLossPrice(positionSide, price);

  out(`Opening ${positionSide} — $${tradeSize.toFixed(2)} (${(CONFIG.tradeSizePct * 100).toFixed(0)}% of $${portfolioValue.toFixed(2)})`);
  out(`Stop loss: $${stopLossPrice.toFixed(2)} (${CONFIG.stopLossPct}%)`);

  let order;
  try {
    order = await executeOrder(side, quantity, stopLossPrice, positionSide);
  } catch (err) {
    out(`❌ Order failed: ${err.message}`);
    return log.join("\n");
  }

  const newPosition = {
    side: positionSide, entryPrice: price, quantity, stopLossPrice,
    sizeUSD: tradeSize, openedAt: new Date().toISOString(), orderId: order.orderId,
  };

  tradeLog.trades.push({
    timestamp: new Date().toISOString(), type: "entry", symbol: CONFIG.symbol,
    side, quantity, price, sizeUSD: tradeSize, portfolioValue,
    orderPlaced: true, orderId: order.orderId, paperTrading: CONFIG.paperTrading,
  });

  // Reload SHAs after the close writes above
  const [freshPosFile, freshPortFile, freshLogFile] = await Promise.all([
    loadState(`position-${sym}.json`),
    loadState(`portfolio-${sym}.json`),
    loadState(`safety-check-log-${sym}.json`),
  ]);

  await saveState(`position-${sym}.json`, newPosition, freshPosFile?.sha);
  await saveState(`portfolio-${sym}.json`, { value: portfolioValue, updatedAt: new Date().toISOString() }, freshPortFile?.sha);
  await saveState(`safety-check-log-${sym}.json`, tradeLog, freshLogFile?.sha);

  out(`✅ ${positionSide.toUpperCase()} opened at $${price.toFixed(2)} | Order: ${order.orderId}`);

  await appendCsvRow({
    side: side.toUpperCase(), quantity, price, totalUSD: tradeSize, orderId: order.orderId,
    mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
    notes: `NKB ${buySignal ? "Buy — bands flipped bullish" : "Sell — bands flipped bearish"} | Portfolio: $${portfolioValue.toFixed(2)}`,
  });

  return log.join("\n");
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
// Same data/layout as dashboard.js, but sourced from the GitHub state files
// instead of the local filesystem — dashboard.js's local reads would be
// stale on Railway since nothing writes those files there.

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
  if (body.code !== "00000") throw new Error(`BitGet balance error: ${body.msg}`);
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

function computePerformanceStats(tradeLog) {
  const entries = tradeLog.trades.filter((t) => t.type === "entry" && t.orderPlaced);
  const exits = tradeLog.trades.filter((t) => t.type === "exit" && t.orderPlaced);

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

function parseTradesCsv(text, limit = 10) {
  if (!text) return [];
  const lines = text.trim().split("\n");
  const rows = lines
    .slice(1) // header
    .map((l) => l.split(","))
    .filter((r) => r[0] !== ""); // skip the funny note row
  return rows.slice(-limit).reverse();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// CSV/JSON timestamps are stored in UTC; render them in US Eastern, 12-hour clock.
function toEastern(utcDate) {
  const date = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(utcDate);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true }).format(utcDate);
  return { date, time };
}

function formatEasternFromParts(dateStr, timeStr) {
  return toEastern(new Date(`${dateStr}T${timeStr}Z`));
}

function formatEasternFromIso(isoStr) {
  return toEastern(new Date(isoStr));
}

const DASHBOARD_SYMBOLS = ["BTCUSDT", "SOLUSDT"];

async function buildSymbolCard(sym) {
  const [portFile, posFile, logFile] = await Promise.all([
    loadState(`portfolio-${sym}.json`),
    loadState(`position-${sym}.json`),
    loadState(`safety-check-log-${sym}.json`),
  ]);

  const tradeLog      = logFile?.data ?? { trades: [] };
  const portfolioValue = portFile?.data?.value ?? 1000;
  const position      = posFile?.data ?? null;
  const startVal      = 1000;
  const totalPct      = ((portfolioValue - startVal) / startVal * 100).toFixed(2);
  const pnlClass      = portfolioValue >= startVal ? "pos" : "neg";

  // Stats
  const allClosed = tradeLog.trades.filter(t => t.type === "exit" || t.type === "stop");
  const wins      = allClosed.filter(t => (t.pnlUSD ?? 0) > 0).length;
  const winRate   = allClosed.length > 0 ? (wins / allClosed.length * 100).toFixed(1) : null;
  const totalPnl  = allClosed.reduce((s, t) => s + (t.pnlUSD ?? 0), 0);

  // Position
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
    const { date, time } = formatEasternFromIso(position.openedAt);
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

  // Recent trades from log
  const recent = tradeLog.trades
    .filter(t => ["entry","exit","stop","pyramid"].includes(t.type))
    .slice(-10).reverse();
  const tradesHtml = recent.length
    ? `<table>
        <tr><th>Time (ET)</th><th>Type</th><th>Side</th><th>Price</th><th>Size</th><th>P&amp;L</th></tr>
        ${recent.map(t => {
          const { date, time } = formatEasternFromIso(t.timestamp);
          const pnl = t.pnlUSD != null
            ? `<span class="${t.pnlUSD >= 0 ? "pos" : "neg"}">${t.pnlUSD >= 0 ? "+" : ""}$${t.pnlUSD.toFixed(2)}</span>`
            : "—";
          const typeClass = t.type === "stop" ? "neg" : t.type === "entry" ? "" : "pos";
          return `<tr>
            <td>${escapeHtml(date)} ${escapeHtml(time)}</td>
            <td class="${typeClass}">${escapeHtml(t.type.toUpperCase())}</td>
            <td>${escapeHtml((t.side||"").toUpperCase())}</td>
            <td>${t.price != null ? "$"+t.price.toFixed(2) : "—"}</td>
            <td>${t.sizeUSD != null ? "$"+t.sizeUSD.toFixed(2) : "—"}</td>
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
        <div class="stat"><span>Value</span><strong>$${portfolioValue.toFixed(2)}</strong></div>
        <div class="stat"><span>Return</span><strong class="${pnlClass}">${totalPct >= 0 ? "+" : ""}${totalPct}%</strong></div>
        <div class="stat"><span>Closed trades</span><strong>${allClosed.length}</strong></div>
        <div class="stat"><span>Win rate</span><strong>${winRate !== null ? winRate + "%" : "—"}</strong></div>
        <div class="stat"><span>Total P&amp;L</span><strong class="${totalPnl >= 0 ? "pos" : "neg"}">${allClosed.length > 0 ? (totalPnl >= 0 ? "+" : "") + "$" + totalPnl.toFixed(2) : "—"}</strong></div>
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

async function buildDashboardHtml() {
  let balanceHtml;
  try {
    const data = await fetchBalance();
    if (CONFIG.tradeMode === "futures") {
      balanceHtml = `<pre style="font-size:12px;color:#aaa;overflow:auto;max-height:120px">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
    } else {
      const usdt = data.find(a => a.coin === "USDT");
      const bal = usdt ? parseFloat(usdt.available) + parseFloat(usdt.frozen) : 0;
      balanceHtml = `<div class="stat"><span>USDT balance</span><strong>$${bal.toFixed(2)}</strong></div>`;
    }
  } catch (err) {
    balanceHtml = `<div class="error">Could not fetch live balance: ${escapeHtml(err.message)}</div>`;
  }

  const symbolCards = await Promise.all(DASHBOARD_SYMBOLS.map(buildSymbolCard));
  const { date, time } = toEastern(new Date());

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="300">
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
  <div class="subtitle">Generated ${date} ${time} ET · NKB + ADX + Trail 3×ATR + Pyramid 3× + 4H MTF · 15m · Paper · refreshes every 5 min</div>

  <div class="card" style="margin-bottom:28px">
    <h2>BitGet Account</h2>
    ${balanceHtml}
  </div>

  ${symbolCards.join("<hr>")}
</body>
</html>`;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok", strategy: "NKB",
      symbol: CONFIG.symbol, timeframe: CONFIG.timeframe,
      mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
    }));
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/dashboard")) {
    const key = new URL(req.url, `http://${req.headers.host}`).searchParams.get("key");
    if (!WEBHOOK_SECRET || key !== WEBHOOK_SECRET) {
      res.writeHead(401); res.end("Unauthorized"); return;
    }
    try {
      const html = await buildDashboardHtml();
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Dashboard error: ${err.message}`);
    }
    return;
  }

  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    // An unhandled 'error' on a request stream crashes the whole Node
    // process (EventEmitter default behavior) — that's what was killing
    // the container and dropping other in-flight TradingView alerts.
    req.on("error", (err) => {
      console.error("Webhook request stream error:", err.message);
    });
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      console.log(`\n[${new Date().toISOString()}] Incoming webhook body: ${JSON.stringify(body)}`);

      // TradingView's standard webhook delivery does not support custom HTTP
      // headers — it only POSTs whatever text is in the alert's Message field.
      // So the secret has to be checked inside that body text, not a header.
      const headerToken = req.headers["x-webhook-secret"] || "";
      const bodyHasSecret = WEBHOOK_SECRET && body.includes(WEBHOOK_SECRET);
      if (WEBHOOK_SECRET && headerToken !== WEBHOOK_SECRET && !bodyHasSecret) {
        console.log("Rejected: WEBHOOK_SECRET not found in header or body");
        res.writeHead(401); res.end("Unauthorized"); return;
      }

      const text   = body.trim().toUpperCase();
      const signal = text.includes("BUY") ? "BUY" : text.includes("SELL") ? "SELL" : null;

      if (!signal) {
        console.log(`Rejected: body has no BUY/SELL — "${body}"`);
        res.writeHead(400);
        res.end("Body must contain BUY or SELL");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      try {
        const result = await queueTrade(signal);
        res.end(result);
      } catch (err) {
        console.error("Trade error:", err);
        res.end(`Error: ${err.message}`);
      }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// Raw socket-level errors (connection reset, bad request line, etc.) happen
// before req/res even exist — without a listener these also crash the process.
server.on("clientError", (err, socket) => {
  console.error("Server clientError:", err.message);
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

// Last-resort nets so one misbehaving request can never take the whole
// bot offline and drop other in-flight TradingView alerts.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

server.listen(PORT, () => {
  console.log(`\nNKB Webhook Server on port ${PORT}`);
  console.log(`Mode: ${CONFIG.paperTrading ? "PAPER" : "LIVE"} | Symbol: ${CONFIG.symbol} | TF: ${CONFIG.timeframe}`);
  console.log(`GitHub repo: ${GITHUB_REPO || "⚠️  GITHUB_REPO not set"}\n`);
});
