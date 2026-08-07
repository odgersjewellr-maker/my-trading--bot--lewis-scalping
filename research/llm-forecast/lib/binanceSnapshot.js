/**
 * Live, current-moment data — no historical backtesting here, this module
 * only ever describes "right now", which is what the forward-only logger
 * needs. All free, keyless Binance USDT-M futures endpoints.
 */
const FAPI = "https://fapi.binance.com";

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance request failed: ${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

/** Last `limit` hourly klines, oldest -> newest. */
export async function fetchRecentKlines(symbol, limit = 100, interval = "1h") {
  const url = `${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await getJson(url);
  return raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    takerBuyBaseVolume: parseFloat(k[9]),
  }));
}

/** One kline covering (or immediately after) a specific past timestamp — used by score.js to resolve outcomes. */
export async function fetchKlineAt(symbol, timestampMs, interval = "1h") {
  const url = `${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${timestampMs}&limit=1`;
  const raw = await getJson(url);
  if (!raw.length) return null;
  const k = raw[0];
  return { openTime: k[0], close: parseFloat(k[4]) };
}

export async function fetchOrderBookSnapshot(symbol, depth = 20) {
  const url = `${FAPI}/fapi/v1/depth?symbol=${symbol}&limit=${depth}`;
  const raw = await getJson(url);
  const bids = raw.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
  const asks = raw.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
  const bidVol = bids.reduce((s, b) => s + b.qty, 0);
  const askVol = asks.reduce((s, a) => s + a.qty, 0);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  return {
    bestBid,
    bestAsk,
    spreadPct: bestBid && bestAsk ? ((bestAsk - bestBid) / bestBid) * 100 : null,
    bidVolume: bidVol,
    askVolume: askVol,
    imbalance: bidVol + askVol > 0 ? (bidVol - askVol) / (bidVol + askVol) : 0, // +1 = all bids, -1 = all asks
  };
}

export async function fetchLatestFunding(symbol) {
  const url = `${FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`;
  const raw = await getJson(url);
  return { rate: parseFloat(raw.lastFundingRate), markPrice: parseFloat(raw.markPrice) };
}

export async function fetchLatestOpenInterest(symbol) {
  const url = `${FAPI}/fapi/v1/openInterest?symbol=${symbol}`;
  const raw = await getJson(url);
  return parseFloat(raw.openInterest);
}
