/**
 * HyroTrader execution adapter — Bybit v5 REST API.
 *
 * HyroTrader (crypto prop firm) executes challenges and funded accounts on
 * Bybit infrastructure via API key/secret. This module mirrors velotrade.js:
 * EXECUTION only (market data / signals stay on public candles) — account
 * equity/balance, positions, market orders, and protective stop orders
 * (place / amend / cancel).
 *
 * Env:
 *   BROKER=hyrotrader            — selects this adapter in bot.js (live mode only)
 *   HYROTRADER_BASE_URL          — Bybit-compatible base; default https://api.bybit.com
 *                                  (HyroTrader may issue a sub-account or a proxied
 *                                   endpoint — set this to whatever they provide)
 *   HYROTRADER_API_KEY           — API key for the challenge/funded account
 *   HYROTRADER_API_SECRET        — API secret (used to SIGN; NEVER logged)
 *   HYROTRADER_ACCOUNT_TYPE      — wallet type: UNIFIED (default) | CONTRACT
 *   SYMBOL                       — Bybit linear-perp symbol, no slash (default SOLUSDT)
 *
 * HyroTrader bot rules encoded for compliance:
 *   - custom bot via API is permitted on the challenge (not third-party EAs);
 *   - a stop-loss must exist within 5 min of every entry — the bot places the
 *     protective stop immediately after entry (htPlaceStopOrder), so this holds;
 *   - <=3% risk per trade — enforced upstream by the bot's sizing (0.5% deployed),
 *     not by this adapter; keep it that way.
 *
 * ⚠ DEMO-VERIFY (run hyrotrader-check.mjs on the FREE TRIAL before any real
 * challenge): base URL, ACCOUNT_TYPE, one-way vs hedge mode (positionIdx),
 * wallet-balance field names, qtyStep rounding, and the sell-stop/buy-stop
 * triggerDirection semantics. Bybit rejects wrong-precision qty and mis-signed
 * requests, so verify end-to-end on the demo first.
 */

import { createHmac } from "crypto";

const BASE = (process.env.HYROTRADER_BASE_URL || "https://api.bybit.com").replace(/\/$/, "");
const API_KEY = process.env.HYROTRADER_API_KEY;
const API_SECRET = process.env.HYROTRADER_API_SECRET;
const ACCOUNT_TYPE = process.env.HYROTRADER_ACCOUNT_TYPE || "UNIFIED";
const SYMBOL = process.env.SYMBOL || "SOLUSDT";      // Bybit linear perps use no-slash symbols
const CATEGORY = "linear";
const RECV_WINDOW = "5000";

function assertConfigured() {
  const missing = [];
  if (!API_KEY) missing.push("HYROTRADER_API_KEY");
  if (!API_SECRET) missing.push("HYROTRADER_API_SECRET");
  if (missing.length) throw new Error(`HyroTrader adapter not configured — missing ${missing.join(", ")}`);
}

// Bybit v5 signature: HMAC-SHA256( timestamp + apiKey + recvWindow + payload )
// payload = querystring for GET, raw JSON body for POST. Secret never leaves here.
function sign(timestamp, payload) {
  return createHmac("sha256", API_SECRET).update(timestamp + API_KEY + RECV_WINDOW + payload).digest("hex");
}

async function htFetch(method, path, params = {}) {
  assertConfigured();
  const ts = Date.now().toString();
  let url = `${BASE}${path}`;
  let body;
  let payload;
  if (method === "GET") {
    payload = new URLSearchParams(params).toString();
    if (payload) url += `?${payload}`;
  } else {
    body = JSON.stringify(params);
    payload = body;
  }
  const res = await fetch(url, {
    method,
    headers: {
      "X-BAPI-API-KEY": API_KEY,
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      "X-BAPI-SIGN": sign(ts, payload),
      "Content-Type": "application/json",
    },
    body,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`HyroTrader/Bybit ${method} ${path}: HTTP ${res.status}, non-JSON body`); }
  // Bybit envelope: retCode 0 = ok. retMsg is safe to surface (no credentials); never log the signature/secret.
  if (data.retCode !== 0) throw new Error(`HyroTrader/Bybit ${method} ${path}: retCode ${data.retCode} — ${data.retMsg ?? "unknown"}`);
  return data.result ?? {};
}

// Public (unsigned) market read — instrument precision. Cached.
let _qtyStep = null;
async function qtyStep() {
  if (_qtyStep != null) return _qtyStep;
  const res = await fetch(`${BASE}/v5/market/instruments-info?category=${CATEGORY}&symbol=${encodeURIComponent(SYMBOL)}`);
  const data = await res.json().catch(() => ({}));
  const step = data?.result?.list?.[0]?.lotSizeFilter?.qtyStep;
  _qtyStep = step ? parseFloat(step) : 0.001;        // DEMO-VERIFY default
  return _qtyStep;
}
function roundQty(q, step) {
  const decimals = (step.toString().split(".")[1] || "").length;
  return (Math.round(q / step) * step).toFixed(decimals);
}

/** Low-level signed request — escape hatch for hyrotrader-check.mjs / diagnostics. */
export async function htRaw(method, path, params = {}) { return htFetch(method, path, params); }

/** Account equity & balance — feeds the bot's own prop guards. */
export async function htAccountMetrics() {
  const r = await htFetch("GET", "/v5/account/wallet-balance", { accountType: ACCOUNT_TYPE });
  const acct = r?.list?.[0] ?? {};
  const equity = acct.totalEquity ?? acct.totalMarginBalance ?? null;
  const balance = acct.totalWalletBalance ?? acct.totalAvailableBalance ?? null;
  return { equity: equity != null ? parseFloat(equity) : null, balance: balance != null ? parseFloat(balance) : null, raw: acct };
}

/** Open positions in our symbol. */
export async function htPositions() {
  const r = await htFetch("GET", "/v5/position/list", { category: CATEGORY, symbol: SYMBOL });
  return Array.isArray(r?.list) ? r.list : [];
}

/** True if a position in our symbol is currently open. */
export async function htHasOpenPosition() {
  const positions = await htPositions();
  return positions.some(p => p.symbol === SYMBOL && Math.abs(parseFloat(p.size ?? 0)) > 0);
}

/** Market order. positionEffect: "OPEN" | "CLOSE". Returns { orderId }. */
export async function htPlaceMarketOrder(side, quantity, positionEffect = "OPEN") {
  const qty = roundQty(parseFloat(quantity), await qtyStep());
  const r = await htFetch("POST", "/v5/order/create", {
    category: CATEGORY,
    symbol: SYMBOL,
    side: side[0].toUpperCase() + side.slice(1).toLowerCase(),   // "Buy" | "Sell"
    orderType: "Market",
    qty,
    timeInForce: "IOC",
    reduceOnly: positionEffect === "CLOSE",
    positionIdx: 0,                                              // one-way mode — DEMO-VERIFY
  });
  return { orderId: r?.orderId ?? null };
}

/**
 * Protective stop: a reduce-only conditional market order (side = the CLOSING
 * side). A long's stop is a Sell that triggers when price FALLS to stopPrice
 * (triggerDirection 2); a short's stop is a Buy triggering on a RISE (1).
 * Returns the orderId for later amend/cancel (trailing ratchet).
 */
export async function htPlaceStopOrder(side, quantity, stopPrice) {
  const qty = roundQty(parseFloat(quantity), await qtyStep());
  const closingSide = side[0].toUpperCase() + side.slice(1).toLowerCase();
  const triggerDirection = closingSide === "Sell" ? 2 : 1;      // DEMO-VERIFY semantics
  const r = await htFetch("POST", "/v5/order/create", {
    category: CATEGORY,
    symbol: SYMBOL,
    side: closingSide,
    orderType: "Market",
    qty,
    triggerPrice: String(stopPrice),
    triggerBy: "LastPrice",
    triggerDirection,
    reduceOnly: true,
    timeInForce: "GTC",
    positionIdx: 0,
    orderFilter: "StopOrder",                                   // conditional order
  });
  return r?.orderId ?? null;
}

export async function htCancelOrder(orderId) {
  await htFetch("POST", "/v5/order/cancel", { category: CATEGORY, symbol: SYMBOL, orderId });
}

/**
 * Trailing ratchet: amend the resting stop's trigger in place (keeps the same
 * orderId). Falls back to cancel + recreate if amend is rejected.
 */
export async function htReplaceStopOrder(oldOrderId, side, quantity, newStopPrice) {
  if (oldOrderId) {
    try {
      await htFetch("POST", "/v5/order/amend", { category: CATEGORY, symbol: SYMBOL, orderId: oldOrderId, triggerPrice: String(newStopPrice) });
      return oldOrderId;
    } catch (err) {
      console.log(`  ⚠️ HyroTrader: stop amend failed, recreating (${err.message})`);
      try { await htCancelOrder(oldOrderId); } catch { /* may already be filled */ }
    }
  }
  return htPlaceStopOrder(side, quantity, newStopPrice);
}

/** Best-effort stop cancel on position close — never throws. */
export async function htSafeCancelStop(stopOrderId) {
  if (!stopOrderId) return;
  try { await htCancelOrder(stopOrderId); }
  catch (err) { console.log(`  HyroTrader: protective stop cancel skipped (${err.message})`); }
}
