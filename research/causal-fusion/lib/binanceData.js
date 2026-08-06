/**
 * Free-tier Binance USDT-M futures data fetchers, disk-cached.
 *
 * Only pulls data that (a) requires no API key and (b) actually has enough
 * history to backtest. Order-book depth and on-chain flow are NOT here —
 * Binance only exposes a live depth snapshot (no history) and there's no
 * free on-chain API wired up. Those stay out of v1 rather than being faked.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "cache");
const FAPI = "https://fapi.binance.com";

if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

function cachePath(name) {
  return join(CACHE_DIR, `${name}.json`);
}

// Cache is keyed by symbol+params and refreshed if older than maxAgeMs.
async function cached(key, maxAgeMs, fetchFn) {
  const path = cachePath(key);
  if (existsSync(path)) {
    const { savedAt, data } = JSON.parse(readFileSync(path, "utf8"));
    if (Date.now() - savedAt < maxAgeMs) return data;
  }
  const data = await fetchFn();
  writeFileSync(path, JSON.stringify({ savedAt: Date.now(), data }));
  return data;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Binance request failed: ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * USDT-M perpetual futures klines. Paginates backward from now.
 * Includes taker-buy-base-volume, which we use as the order-flow /
 * CVD-delta proxy since real order-book history isn't free.
 */
export async function fetchFuturesKlines(symbol, interval, days) {
  const key = `klines-${symbol}-${interval}-${days}d`;
  return cached(key, 30 * 60 * 1000, async () => {
    const msPerBar = intervalToMs(interval);
    const earliest = Date.now() - days * 24 * 60 * 60 * 1000;
    const out = [];
    let endTime = Date.now();

    while (endTime > earliest) {
      const url = `${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=1500&endTime=${endTime}`;
      const batch = await getJson(url);
      if (!batch.length) break;

      for (const k of batch) {
        out.push({
          openTime: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          closeTime: k[6],
          trades: k[8],
          takerBuyBaseVolume: parseFloat(k[9]),
        });
      }

      const oldest = batch[0][0];
      if (oldest <= earliest || batch.length < 1500) break;
      endTime = oldest - msPerBar;
      await sleep(200);
    }

    out.sort((a, b) => a.openTime - b.openTime);
    return out.filter((c) => c.openTime >= earliest);
  });
}

/** Funding rate history — Binance retains this far back (unlike OI). */
export async function fetchFundingHistory(symbol, days) {
  const key = `funding-${symbol}-${days}d`;
  return cached(key, 30 * 60 * 1000, async () => {
    const earliest = Date.now() - days * 24 * 60 * 60 * 1000;
    const out = [];
    let startTime = earliest;

    while (startTime < Date.now()) {
      const url = `${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=1000&startTime=${startTime}`;
      const batch = await getJson(url);
      if (!batch.length) break;
      for (const f of batch) {
        out.push({ time: f.fundingTime, rate: parseFloat(f.fundingRate) });
      }
      const last = batch[batch.length - 1].fundingTime;
      if (last <= startTime || batch.length < 1000) break;
      startTime = last + 1;
      await sleep(200);
    }
    return out;
  });
}

/**
 * Open interest history. NOTE: Binance's free openInterestHist endpoint
 * only serves roughly the last 30 days regardless of period — this is a
 * platform limitation, not something we can page around. The cascade
 * ensemble degrades gracefully (drops OI-derived votes) outside that
 * window rather than pretending it has data it doesn't.
 */
export async function fetchOpenInterestHistory(symbol, period = "1h") {
  const key = `oi-${symbol}-${period}`;
  return cached(key, 15 * 60 * 1000, async () => {
    const url = `${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=500`;
    const batch = await getJson(url);
    return batch.map((o) => ({
      time: o.timestamp,
      sumOpenInterest: parseFloat(o.sumOpenInterest),
    }));
  });
}

function intervalToMs(interval) {
  const unit = interval.slice(-1);
  const n = parseInt(interval.slice(0, -1), 10);
  const table = { m: 60e3, h: 3600e3, d: 86400e3 };
  if (!table[unit]) throw new Error(`Unsupported interval: ${interval}`);
  return n * table[unit];
}
