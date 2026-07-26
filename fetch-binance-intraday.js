/**
 * Fetch intraday Binance klines → timestamped CSV for opening-drive.js.
 *
 * Usage:
 *   node fetch-binance-intraday.js [SYMBOL] [INTERVAL] [DAYS]
 *   node fetch-binance-intraday.js BTCUSDT 15m 365
 *
 * Output: <symbol>-<interval>-binance.csv   (Timestamp,Open,High,Low,Close,Volume)
 * Timestamp is full ISO8601 UTC so the backtest can anchor to a session open.
 *
 * Note: Binance's API must be reachable from wherever you run this (your VPS or
 * laptop). Some hosted/CI environments block api.binance.com — run it locally.
 */

import { writeFileSync } from "fs";
import https from "https";

const SYMBOL   = (process.argv[2] || "BTCUSDT").toUpperCase();
const INTERVAL = process.argv[3] || "15m";
const DAYS     = parseInt(process.argv[4] || "365", 10);
const LIMIT    = 1000; // max klines per request
const OUT_FILE = `${SYMBOL.toLowerCase()}-${INTERVAL}-binance.csv`;

// Try the public data mirror first, then the main API.
const HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function getKlines(path) {
  let lastErr;
  for (const host of HOSTS) {
    try { return await get(host + path); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function fetchAll() {
  const candles = [];
  let endTime = Date.now();
  const earliest = endTime - DAYS * 86_400_000;

  console.log(`Fetching ${SYMBOL} ${INTERVAL} candles from Binance (~${DAYS} days)...`);

  while (endTime > earliest) {
    const path = `/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${LIMIT}&endTime=${endTime}`;
    const batch = await getKlines(path);
    if (!batch.length) break;

    for (const k of batch) {
      candles.push({
        ts:     k[0],
        open:   parseFloat(k[1]),
        high:   parseFloat(k[2]),
        low:    parseFloat(k[3]),
        close:  parseFloat(k[4]),
        volume: parseFloat(k[5]),
      });
    }

    endTime = batch[0][0] - 1; // step back before the earliest candle in this batch
    process.stdout.write(`  got ${candles.length} candles, back to ${new Date(batch[0][0]).toISOString()}\r`);
    await new Promise((r) => setTimeout(r, 250)); // be polite to the rate limiter
  }

  // De-dup + sort oldest → newest, keep only within the requested window
  const seen = new Set();
  const rows = candles
    .filter((c) => c.ts >= earliest && !isNaN(c.close))
    .filter((c) => (seen.has(c.ts) ? false : seen.add(c.ts)))
    .sort((a, b) => a.ts - b.ts)
    .map((c) => `${new Date(c.ts).toISOString()},${c.open},${c.high},${c.low},${c.close},${c.volume}`);

  writeFileSync(OUT_FILE, ["Timestamp,Open,High,Low,Close,Volume", ...rows].join("\n"));
  console.log(`\nSaved ${rows.length} candles to ${OUT_FILE}`);
  if (rows.length) {
    console.log(`Range: ${rows[0].split(",")[0]} → ${rows[rows.length - 1].split(",")[0]}`);
    console.log(`\nNext:  node opening-drive.js ${OUT_FILE}`);
  }
}

fetchAll().catch((e) => {
  console.error("\nFetch failed:", e.message);
  console.error("If this host is blocked (403/451), run this on your VPS or laptop where Binance is reachable.");
  process.exit(1);
});
