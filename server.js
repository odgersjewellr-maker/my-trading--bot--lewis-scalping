/**
 * NKB Webhook Server
 *
 * TradingView fires an alert → POSTs to this server → executes instantly.
 * Reads/writes state via GitHub API so it stays in sync with the cron bot.
 *
 * Required Railway env vars:
 *   BITGET_API_KEY, BITGET_SECRET_KEY, BITGET_PASSPHRASE
 *   GITHUB_TOKEN   — personal access token with repo write scope
 *   GITHUB_REPO    — e.g. odgersjewellr-maker/my-trading--bot--lewis-scalping
 *   WEBHOOK_SECRET — any password you choose (must match TradingView alert header)
 *   PAPER_TRADING=true
 *   TRADE_MODE=futures
 *   SYMBOL=BTCUSDT
 *   TIMEFRAME=5m
 *   PORTFOLIO_VALUE_USD=640
 */

import "dotenv/config";
import { createServer } from "http";
import crypto from "crypto";
import { CONFIG, fetchCandles, signBitGet, computeStopLossPrice } from "./bot.js";

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

// ─── BitGet order execution ───────────────────────────────────────────────────

async function executeOrder(side, quantity, stopLossPrice) {
  if (CONFIG.paperTrading) return { orderId: `PAPER-${Date.now()}`, paper: true };

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

  // Load all state from GitHub
  const [posFile, portFile, stateFile, logFile] = await Promise.all([
    loadState("position.json"),
    loadState("portfolio.json"),
    loadState("nkb-state.json"),
    loadState("safety-check-log.json"),
  ]);

  let position      = posFile?.data ?? null;
  let portfolioValue = portFile?.data?.value ?? CONFIG.portfolioValue;
  const prevNKBState = stateFile?.data?.state ?? 0;
  const tradeLog     = logFile?.data ?? { trades: [] };

  const buySignal  = signal === "BUY";
  const sellSignal = signal === "SELL";

  // Save new NKB state
  const newNKBState = buySignal ? 1 : -1;
  await saveState("nkb-state.json",
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
    tradeLog.trades.push({
      timestamp: new Date().toISOString(), type: "exit", symbol: CONFIG.symbol,
      side: closeSide, quantity: position.quantity, price, sizeUSD: position.sizeUSD,
      pnlUSD, pnlPct, reason: "NKB webhook reversal", orderPlaced: true,
      orderId: closeOrder.orderId, paperTrading: CONFIG.paperTrading,
    });

    // Each saveState() creates its own commit on the same branch — running
    // these in parallel makes them race for the branch HEAD, so the 2nd/3rd
    // commit gets rejected with a 409 (confirmed in Railway logs: GitHub
    // returned the just-created sibling commit's sha as the conflict).
    // They must run sequentially, one commit at a time.
    await saveState("portfolio.json", { value: portfolioValue, updatedAt: new Date().toISOString() }, portFile?.sha);
    await saveState("position.json", null, posFile?.sha);
    await saveState("safety-check-log.json", tradeLog, logFile?.sha);
    position = null;
    out(`Portfolio: $${portfolioValue.toFixed(2)}`);
  }

  // Open new position
  const canShort   = CONFIG.tradeMode === "futures";
  if (sellSignal && !canShort) {
    out("SELL signal — spot mode, can't short. Staying flat.");
    return log.join("\n");
  }

  const tradeSize   = portfolioValue * 0.10;
  const side        = buySignal ? "buy" : "sell";
  const positionSide = buySignal ? "long" : "short";
  const quantity    = parseFloat((tradeSize / price).toFixed(6));
  const stopLossPrice = computeStopLossPrice(positionSide, price);

  out(`Opening ${positionSide} — $${tradeSize.toFixed(2)} (10% of $${portfolioValue.toFixed(2)})`);
  out(`Stop loss: $${stopLossPrice.toFixed(2)} (${CONFIG.stopLossPct}%)`);

  let order;
  try {
    order = await executeOrder(side, quantity, stopLossPrice);
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
    loadState("position.json"),
    loadState("portfolio.json"),
    loadState("safety-check-log.json"),
  ]);

  // Sequential for the same reason as the close block above — concurrent
  // commits to the same branch race for the HEAD and 409 on each other.
  await saveState("position.json", newPosition, freshPosFile?.sha);
  await saveState("portfolio.json", { value: portfolioValue, updatedAt: new Date().toISOString() }, freshPortFile?.sha);
  await saveState("safety-check-log.json", tradeLog, freshLogFile?.sha);

  out(`✅ ${positionSide.toUpperCase()} opened at $${price.toFixed(2)} | Order: ${order.orderId}`);
  return log.join("\n");
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
