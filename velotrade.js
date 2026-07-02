/**
 * Velotrade execution adapter — DXtrade SCA-style REST API (dx.velotrade.com).
 *
 * Scope: EXECUTION only. Market data / signals stay on public exchange candles;
 * this module handles login, account equity/balance, positions, market orders,
 * and protective stop orders (place / cancel / replace).
 *
 * Env:
 *   BROKER=velotrade            — enables this adapter in bot.js (live mode only)
 *   VELOTRADE_BASE_URL          — default https://dx.velotrade.com
 *   VELOTRADE_USERNAME          — trading account username
 *   VELOTRADE_PASSWORD          — trading account password
 *   VELOTRADE_DOMAIN            — default "default"
 *   VELOTRADE_ACCOUNT           — account code (e.g. from the dashboard)
 *   VELOTRADE_INSTRUMENT        — instrument symbol; default derives from SYMBOL
 *                                 (SOLUSDT -> SOL/USDT)
 *
 * ⚠ DEMO-VERIFY: endpoint paths and field names follow the DXtrade SCA convention
 * shown in Velotrade's public API page (login, POST accounts/{code}/orders with
 * account/orderCode/type/instrument/quantity/positionEffect/side/tif). Exact
 * response field names (equity/balance keys, stop order price field) MUST be
 * verified against the demo environment with velotrade-check.mjs before any
 * challenge money is at stake.
 */

const BASE = process.env.VELOTRADE_BASE_URL || "https://dx.velotrade.com";
const USERNAME = process.env.VELOTRADE_USERNAME;
const PASSWORD = process.env.VELOTRADE_PASSWORD;
const DOMAIN = process.env.VELOTRADE_DOMAIN || "default";
const ACCOUNT = process.env.VELOTRADE_ACCOUNT;

function defaultInstrument() {
  const sym = process.env.SYMBOL || "SOLUSDT";
  for (const quote of ["USDT", "USDC", "USD"]) {
    if (sym.endsWith(quote)) return `${sym.slice(0, -quote.length)}/${quote}`;
  }
  return sym;
}
const INSTRUMENT = process.env.VELOTRADE_INSTRUMENT || defaultInstrument();

let sessionToken = null;

function assertConfigured() {
  const missing = [];
  if (!USERNAME) missing.push("VELOTRADE_USERNAME");
  if (!PASSWORD) missing.push("VELOTRADE_PASSWORD");
  if (!ACCOUNT) missing.push("VELOTRADE_ACCOUNT");
  if (missing.length) throw new Error(`Velotrade adapter not configured — missing ${missing.join(", ")}`);
}

async function vtLogin() {
  assertConfigured();
  const res = await fetch(`${BASE}/dxsca-web/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, domain: DOMAIN, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Velotrade login failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.sessionToken) throw new Error("Velotrade login: no sessionToken in response");
  sessionToken = data.sessionToken;
  // Never log the token itself
  console.log("  Velotrade: session established");
}

async function vtFetch(path, { method = "GET", body } = {}, allowRelogin = true) {
  if (!sessionToken) await vtLogin();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `DXAPI ${sessionToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && allowRelogin) {
    sessionToken = null;
    return vtFetch(path, { method, body }, false);
  }
  const text = await res.text();
  if (!res.ok) {
    // Response bodies can echo request details but never credentials; safe to include
    throw new Error(`Velotrade API ${method} ${path}: HTTP ${res.status}${text ? ` — ${text.slice(0, 300)}` : ""}`);
  }
  return text ? JSON.parse(text) : {};
}

/** Account equity & balance — the firm's own numbers, used by prop guards. */
export async function vtAccountMetrics() {
  const data = await vtFetch(`/dxsca-web/accounts/${encodeURIComponent(ACCOUNT)}/metrics`);
  // Field-name fallbacks across DXtrade SCA versions (verify on demo):
  const m = Array.isArray(data?.metrics) ? data.metrics[0] : (data?.metrics ?? data);
  const equity = m?.equity ?? m?.accountEquity ?? m?.netLiquidationValue ?? null;
  const balance = m?.balance ?? m?.accountBalance ?? m?.cashBalance ?? null;
  return { equity: equity != null ? parseFloat(equity) : null, balance: balance != null ? parseFloat(balance) : null, raw: m };
}

/** Open positions for the account. */
export async function vtPositions() {
  const data = await vtFetch(`/dxsca-web/accounts/${encodeURIComponent(ACCOUNT)}/positions`);
  return Array.isArray(data?.positions) ? data.positions : Array.isArray(data) ? data : [];
}

/** True if the account currently holds a position in our instrument. */
export async function vtHasOpenPosition() {
  const positions = await vtPositions();
  return positions.some(p => {
    const sym = p.instrument ?? p.symbol ?? "";
    const qty = Math.abs(parseFloat(p.quantity ?? p.size ?? 0));
    return sym === INSTRUMENT && qty > 0;
  });
}

/** Market order. positionEffect: "OPEN" | "CLOSE". Returns { orderId }. */
export async function vtPlaceMarketOrder(side, quantity, positionEffect = "OPEN") {
  const orderCode = `nkb-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  await vtFetch(`/dxsca-web/accounts/${encodeURIComponent(ACCOUNT)}/orders`, {
    method: "POST",
    body: {
      account: ACCOUNT,
      orderCode,
      type: "MARKET",
      instrument: INSTRUMENT,
      quantity: parseFloat(quantity),
      positionEffect,
      side: side.toUpperCase(),
      tif: "GTC",
    },
  });
  return { orderId: orderCode };
}

/** Protective stop order resting on the firm's book (side = closing side). */
export async function vtPlaceStopOrder(side, quantity, stopPrice) {
  const orderCode = `nkb-stop-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  await vtFetch(`/dxsca-web/accounts/${encodeURIComponent(ACCOUNT)}/orders`, {
    method: "POST",
    body: {
      account: ACCOUNT,
      orderCode,
      type: "STOP",
      instrument: INSTRUMENT,
      quantity: parseFloat(quantity),
      positionEffect: "CLOSE",
      side: side.toUpperCase(),
      price: parseFloat(stopPrice), // DEMO-VERIFY: some SCA versions use stopPrice/triggerPrice
      tif: "GTC",
    },
  });
  return orderCode;
}

export async function vtCancelOrder(orderCode) {
  await vtFetch(`/dxsca-web/accounts/${encodeURIComponent(ACCOUNT)}/orders/${encodeURIComponent(orderCode)}`, {
    method: "DELETE",
  });
}

/** Cancel-and-replace the protective stop (trailing ratchet). Returns new orderCode. */
export async function vtReplaceStopOrder(oldOrderCode, side, quantity, newStopPrice) {
  if (oldOrderCode) {
    try { await vtCancelOrder(oldOrderCode); }
    catch (err) { console.log(`  ⚠️ Velotrade: old stop cancel failed (may be filled): ${err.message}`); }
  }
  return vtPlaceStopOrder(side, quantity, newStopPrice);
}

/** Best-effort stop cancel on position close — never throws. */
export async function vtSafeCancelStop(stopOrderId) {
  if (!stopOrderId) return;
  try { await vtCancelOrder(stopOrderId); }
  catch (err) { console.log(`  Velotrade: protective stop cancel skipped (${err.message})`); }
}
