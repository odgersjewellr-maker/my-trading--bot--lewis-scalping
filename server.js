/**
 * NKB Webhook Server
 *
 * TradingView fires an alert → POSTs to this server → bot executes instantly.
 * Deploy on Railway so it's always online.
 *
 * Webhook URL:  https://your-railway-url.up.railway.app/webhook
 * Secret token: set WEBHOOK_SECRET in Railway env vars
 */

import "dotenv/config";
import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { pathToFileURL } from "url";

// Import all shared bot logic
import {
  CONFIG,
  LOG_FILE,
  POSITION_FILE,
  PORTFOLIO_FILE,
  STATE_FILE,
  fetchCandles,
  loadPosition,
  signBitGet,
  CSV_FILE,
} from "./bot.js";

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// ─── Helpers (duplicated from bot.js for standalone use) ────────────────────

function loadPortfolio() {
  if (!existsSync(PORTFOLIO_FILE)) return CONFIG.portfolioValue;
  return JSON.parse(readFileSync(PORTFOLIO_FILE, "utf8")).value;
}
function savePortfolio(value) {
  writeFileSync(PORTFOLIO_FILE, JSON.stringify({ value, updatedAt: new Date().toISOString() }, null, 2));
}
function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}
function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}
function loadNKBState() {
  if (!existsSync(STATE_FILE)) return 0;
  return JSON.parse(readFileSync(STATE_FILE, "utf8")).state ?? 0;
}
function saveNKBState(state) {
  writeFileSync(STATE_FILE, JSON.stringify({ state, updatedAt: new Date().toISOString() }, null, 2));
}

const CSV_HEADERS = "Date,Time (UTC),Exchange,Symbol,Side,Quantity,Price,Total USD,Fee (est.),Net Amount,Order ID,Mode,Notes";
function writeCsvRow({ side = "", quantity = "", price, totalUSD = "", orderId = "", mode, notes = "" }) {
  const now = new Date();
  const fee = totalUSD !== "" ? (parseFloat(totalUSD) * 0.001).toFixed(4) : "";
  const net = totalUSD !== "" && fee !== "" ? (parseFloat(totalUSD) - parseFloat(fee)).toFixed(2) : "";
  const row = [now.toISOString().slice(0, 10), now.toISOString().slice(11, 19), "BitGet", CONFIG.symbol, side, quantity, price !== undefined ? price.toFixed(2) : "", totalUSD, fee, net, orderId, mode, `"${notes}"`].join(",");
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
}

async function executeOrder(side, quantity) {
  if (CONFIG.paperTrading) return { orderId: `PAPER-${Date.now()}`, paper: true };
  const qty = parseFloat(quantity).toFixed(6);
  const timestamp = Date.now().toString();
  const path = "/api/v2/spot/trade/placeOrder";
  const body = JSON.stringify({ symbol: CONFIG.symbol, side, orderType: "market", quantity: qty });
  const signature = signBitGet(timestamp, "POST", path, body);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ACCESS-KEY": CONFIG.bitget.apiKey, "ACCESS-SIGN": signature, "ACCESS-TIMESTAMP": timestamp, "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase },
    body,
  });
  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet order failed: ${data.msg}`);
  return { orderId: data.data.orderId, paper: false };
}

// ─── Trade execution ─────────────────────────────────────────────────────────

async function executeTrade(signal) {
  const log = [""];
  const out = (msg) => { console.log(msg); log.push(msg); };

  out(`\n[${new Date().toISOString()}] Webhook received: ${signal.toUpperCase()}`);

  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const price = candles[candles.length - 1].close;
  out(`Price: $${price.toFixed(2)}`);

  let portfolioValue = loadPortfolio();
  let position = loadPosition();
  const prevNKBState = loadNKBState();

  const buySignal  = signal === "BUY";
  const sellSignal = signal === "SELL";

  // Save new state
  saveNKBState(buySignal ? 1 : -1);

  // ── Close existing position if it's a reversal ──────────────────────────
  if (position) {
    const isReversal = (position.side === "long" && sellSignal) || (position.side === "short" && buySignal);
    if (isReversal) {
      const closeSide = position.side === "long" ? "sell" : "buy";
      const pnlUSD = position.side === "long"
        ? (price - position.entryPrice) * position.quantity
        : (position.entryPrice - price) * position.quantity;
      const pnlPct = (pnlUSD / position.sizeUSD) * 100;

      out(`Closing ${position.side} — P&L $${pnlUSD.toFixed(2)} (${pnlPct.toFixed(2)}%)`);

      let order;
      try {
        order = await executeOrder(closeSide, position.quantity);
      } catch (err) {
        out(`❌ Close failed: ${err.message}`);
        return log.join("\n");
      }

      portfolioValue += pnlUSD;
      savePortfolio(portfolioValue);
      out(`Portfolio updated: $${portfolioValue.toFixed(2)}`);

      log.push(""); // spacer
      saveLog({ ...loadLog(), trades: [...loadLog().trades, { timestamp: new Date().toISOString(), type: "exit", symbol: CONFIG.symbol, side: closeSide, quantity: position.quantity, price, sizeUSD: position.sizeUSD, pnlUSD, pnlPct, reason: "NKB webhook reversal", orderPlaced: true, orderId: order.orderId, paperTrading: CONFIG.paperTrading }] });
      writeCsvRow({ side: closeSide.toUpperCase(), quantity: position.quantity, price, totalUSD: position.sizeUSD, orderId: order.orderId, mode: CONFIG.paperTrading ? "PAPER" : "LIVE", notes: `NKB reversal exit — P&L $${pnlUSD.toFixed(2)} (${pnlPct.toFixed(2)}%) | Portfolio: $${portfolioValue.toFixed(2)}` });
      writeFileSync(POSITION_FILE, JSON.stringify(null, null, 2));
      position = null;
    } else {
      out(`Already in ${position.side} — signal matches direction, holding`);
      return log.join("\n");
    }
  }

  // ── Open new position ──────────────────────────────────────────────────
  const canShort = CONFIG.tradeMode === "futures";
  if (sellSignal && !canShort) {
    out("SELL signal — spot mode can't short. Staying flat.");
    writeCsvRow({ price, orderId: "BLOCKED", mode: "BLOCKED", notes: "NKB Sell webhook — shorting unavailable in spot mode" });
    return log.join("\n");
  }

  const tradeSize = portfolioValue * 0.10;
  const side = buySignal ? "buy" : "sell";
  const positionSide = buySignal ? "long" : "short";
  const quantity = parseFloat((tradeSize / price).toFixed(6));

  out(`Opening ${positionSide} — $${tradeSize.toFixed(2)} (10% of $${portfolioValue.toFixed(2)})`);

  let order;
  try {
    order = await executeOrder(side, quantity);
  } catch (err) {
    out(`❌ Order failed: ${err.message}`);
    writeCsvRow({ price, orderId: "FAILED", mode: "BLOCKED", notes: `Order failed: ${err.message}` });
    return log.join("\n");
  }

  writeFileSync(POSITION_FILE, JSON.stringify({ side: positionSide, entryPrice: price, quantity, sizeUSD: tradeSize, openedAt: new Date().toISOString(), orderId: order.orderId }, null, 2));
  saveLog({ ...loadLog(), trades: [...loadLog().trades, { timestamp: new Date().toISOString(), type: "entry", symbol: CONFIG.symbol, side, quantity, price, sizeUSD: tradeSize, portfolioValue, orderPlaced: true, orderId: order.orderId, paperTrading: CONFIG.paperTrading }] });
  writeCsvRow({ side: side.toUpperCase(), quantity, price, totalUSD: tradeSize, orderId: order.orderId, mode: CONFIG.paperTrading ? "PAPER" : "LIVE", notes: `NKB webhook ${signal} | Portfolio: $${portfolioValue.toFixed(2)}` });

  out(`✅ ${positionSide.toUpperCase()} opened at $${price.toFixed(2)} | Order: ${order.orderId}`);
  return log.join("\n");
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", strategy: "NKB", symbol: CONFIG.symbol, timeframe: CONFIG.timeframe, mode: CONFIG.paperTrading ? "PAPER" : "LIVE" }));
    return;
  }

  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      // Optional secret token check
      if (WEBHOOK_SECRET) {
        const token = req.headers["x-webhook-secret"] || "";
        if (token !== WEBHOOK_SECRET) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
      }

      const text = body.trim().toUpperCase();
      const signal = text.includes("BUY") ? "BUY" : text.includes("SELL") ? "SELL" : null;

      if (!signal) {
        res.writeHead(400);
        res.end("Unknown signal — body must contain BUY or SELL");
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

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`\nNKB Webhook Server running on port ${PORT}`);
  console.log(`Health: GET  /`);
  console.log(`Signal: POST /webhook  (body: "BUY" or "SELL")`);
  console.log(`Mode:   ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}\n`);
});
