/**
 * Daily spot close prices from Binance (free, no key) — this signal
 * operates on a multi-day horizon, so daily bars are enough resolution
 * and keep the dataset small next to years of mint-event history.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "cache");
const SPOT = "https://api.binance.com";

if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

async function cached(key, maxAgeMs, fetchFn) {
  const path = join(CACHE_DIR, `${key}.json`);
  if (existsSync(path)) {
    const { savedAt, data } = JSON.parse(readFileSync(path, "utf8"));
    if (Date.now() - savedAt < maxAgeMs) return data;
  }
  const data = await fetchFn();
  writeFileSync(path, JSON.stringify({ savedAt: Date.now(), data }));
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance request failed: ${res.status} ${res.statusText}`);
  return res.json();
}

export async function fetchDailyCloses(symbol, days) {
  const key = `daily-${symbol}-${days}d`;
  return cached(key, 6 * 60 * 60 * 1000, async () => {
    const earliest = Date.now() - days * 24 * 60 * 60 * 1000;
    const out = [];
    let endTime = Date.now();

    while (endTime > earliest) {
      const url = `${SPOT}/api/v3/klines?symbol=${symbol}&interval=1d&limit=1000&endTime=${endTime}`;
      const batch = await getJson(url);
      if (!batch.length) break;
      for (const k of batch) {
        out.push({ time: k[0], close: parseFloat(k[4]) });
      }
      const oldest = batch[0][0];
      if (oldest <= earliest || batch.length < 1000) break;
      endTime = oldest - 86400000;
      await sleep(200);
    }

    out.sort((a, b) => a.time - b.time);
    return out.filter((c) => c.time >= earliest);
  });
}
