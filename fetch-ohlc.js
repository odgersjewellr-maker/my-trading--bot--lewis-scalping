/**
 * Fetch OHLC candles from Binance for ANY symbol / interval — a generalised
 * version of fetch-binance.js for backtesting other timeframes locally.
 *
 * Usage:
 *   node fetch-ohlc.js [SYMBOL] [INTERVAL] [OUTFILE] [START_DATE]
 *
 * Examples:
 *   node fetch-ohlc.js BTCUSDT 1h  btc-1h.csv  2023-01-01
 *   node fetch-ohlc.js BTCUSDT 4h  btc-4h.csv  2022-01-01
 *   node fetch-ohlc.js ETHUSDT 1d  eth-daily.csv
 *
 * Then backtest it (any timeframe — Sharpe auto-annualises):
 *   node backtest-hast-pro.js btc-1h.csv
 *
 * NOTE: run this on your own machine. Cloud/CI sandboxes often block the
 * exchange APIs, which is why the strategy ships validated on daily data only.
 * Intervals: 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w
 */

import { writeFileSync } from "fs";
import https from "https";

const SYMBOL   = (process.argv[2] || "BTCUSDT").toUpperCase();
const INTERVAL = process.argv[3] || "1h";
const OUT_FILE = process.argv[4] || `${SYMBOL.toLowerCase()}-${INTERVAL}.csv`;
// Default lookback: intraday timeframes get ~2 years (plenty, and fast); daily gets 2018.
const intraday = /[mh]/.test(INTERVAL);
const START    = process.argv[5] || (intraday ? "2023-01-01" : "2018-01-01");
const LIMIT    = 1000; // Binance max per request

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Bad response: ${data.slice(0, 200)}`)); }
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function fetchAll() {
  const candles = [];
  let endTime = Date.now();
  const earliest = new Date(START).getTime();

  console.log(`Fetching ${SYMBOL} ${INTERVAL} candles from Binance (since ${START})...`);

  while (endTime > earliest) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${LIMIT}&endTime=${endTime}`;
    const batch = await get(url);
    if (!Array.isArray(batch) || !batch.length) break;

    for (const k of batch) {
      const iso = new Date(k[0]).toISOString();
      // Intraday keeps the time (unique, sortable); daily/weekly keep date only.
      const date = intraday ? iso.slice(0, 19) + "Z" : iso.slice(0, 10);
      candles.push({ ts: k[0], date, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    }

    endTime = batch[0][0] - 1; // step back before the earliest candle in this batch
    process.stdout.write(`  fetched back to ${new Date(batch[0][0]).toISOString().slice(0, 10)}\r`);
    await new Promise((r) => setTimeout(r, 250)); // rate limit
  }

  // de-dupe + sort oldest → newest
  const seen = new Set();
  const rows = candles
    .filter((c) => c.ts >= earliest && !seen.has(c.ts) && seen.add(c.ts))
    .sort((a, b) => a.ts - b.ts)
    .map((c) => `${c.date},${c.open},${c.high},${c.low},${c.close},${c.volume}`);

  writeFileSync(OUT_FILE, ["Date,Open,High,Low,Close,Volume", ...rows].join("\n"));
  console.log(`\nSaved ${rows.length} candles to ${OUT_FILE}`);
  if (rows.length) console.log(`Range: ${rows[0].split(",")[0]} → ${rows[rows.length - 1].split(",")[0]}`);
  console.log(`\nNext:  node backtest-hast-pro.js ${OUT_FILE}`);
}

fetchAll().catch((e) => { console.error("Fetch failed:", e.message); process.exit(1); });
