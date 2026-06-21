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
import { CONFIG, fetchCandles, signBitGet } from "./bot.js";

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

async function executeOrder(side, quantity) {
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

    await Promise.all([
      saveState("portfolio.json", { value: portfolioValue, updatedAt: new Date().toISOString() }, portFile?.sha),
      saveState("position.json", null, posFile?.sha),
      saveState("safety-check-log.json", tradeLog, logFile?.sha),
    ]);
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

  out(`Opening ${positionSide} — $${tradeSize.toFixed(2)} (10% of $${portfolioValue.toFixed(2)})`);

  let order;
  try {
    order = await executeOrder(side, quantity);
  } catch (err) {
    out(`❌ Order failed: ${err.message}`);
    return log.join("\n");
  }

  const newPosition = {
    side: positionSide, entryPrice: price, quantity,
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

  await Promise.all([
    saveState("position.json", newPosition, freshPosFile?.sha),
    saveState("portfolio.json", { value: portfolioValue, updatedAt: new Date().toISOString() }, freshPortFile?.sha),
    saveState("safety-check-log.json", tradeLog, freshLogFile?.sha),
  ]);

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
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      if (WEBHOOK_SECRET) {
        const token = req.headers["x-webhook-secret"] || "";
        if (token !== WEBHOOK_SECRET) {
          res.writeHead(401); res.end("Unauthorized"); return;
        }
      }

      const text   = body.trim().toUpperCase();
      const signal = text.includes("BUY") ? "BUY" : text.includes("SELL") ? "SELL" : null;

      if (!signal) {
        res.writeHead(400);
        res.end("Body must contain BUY or SELL");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      try {
        const result = await executeTrade(signal);
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

server.listen(PORT, () => {
  console.log(`\nNKB Webhook Server on port ${PORT}`);
  console.log(`Mode: ${CONFIG.paperTrading ? "PAPER" : "LIVE"} | Symbol: ${CONFIG.symbol} | TF: ${CONFIG.timeframe}`);
  console.log(`GitHub repo: ${GITHUB_REPO || "⚠️  GITHUB_REPO not set"}\n`);
});
