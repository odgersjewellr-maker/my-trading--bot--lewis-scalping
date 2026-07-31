/**
 * Generic intraday candle fetcher for Binance — needed to properly backtest
 * daily-range-breakout.js, since the real strategy (fixed prior-day box,
 * checked against every intraday candle) needs 1H (or similar) data, not
 * daily candles.
 *
 * Usage: node fetch-binance-intraday.js [symbol] [interval] [days] [outFile]
 *   node fetch-binance-intraday.js SOLUSDT 1h 365 sol-1h-binance.csv
 *
 * Defaults: SOLUSDT, 1h, 365 days, sol-1h-binance.csv
 */

import { writeFileSync } from "fs";
import https from "https";

const SYMBOL   = process.argv[2] || "SOLUSDT";
const INTERVAL = process.argv[3] || "1h";
const DAYS     = parseInt(process.argv[4] || "365", 10);
const OUT_FILE = process.argv[5] || `${SYMBOL.toLowerCase()}-${INTERVAL}-binance.csv`;
const LIMIT    = 1000; // max per request

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = "";
      res.on("data", d => (data += d));
      res.on("end", () => resolve(JSON.parse(data)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function fetchAll() {
  const candles = [];
  let endTime = Date.now();
  const earliest = endTime - DAYS * 24 * 60 * 60 * 1000;

  console.log(`Fetching ${SYMBOL} ${INTERVAL} candles from Binance (last ${DAYS} days)...`);

  while (endTime > earliest) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${LIMIT}&endTime=${endTime}`;
    const batch = await get(url);
    if (!Array.isArray(batch) || !batch.length) break;

    for (const k of batch) {
      const ts     = k[0];
      const open   = parseFloat(k[1]);
      const high   = parseFloat(k[2]);
      const low    = parseFloat(k[3]);
      const close  = parseFloat(k[4]);
      const vol    = parseFloat(k[5]);
      const date   = new Date(ts).toISOString().slice(0, 19); // full timestamp, not just the date
      candles.push({ date, open, high, low, close, volume: vol });
    }

    endTime = batch[0][0] - 1;
    process.stdout.write(`  fetched back to ${new Date(batch[0][0]).toISOString()}\r`);

    await new Promise(r => setTimeout(r, 250)); // rate limit
  }

  candles.sort((a, b) => a.date.localeCompare(b.date));

  const header = "Date,Open,High,Low,Close,Volume";
  const rows = candles.map(c => `${c.date},${c.open},${c.high},${c.low},${c.close},${c.volume}`);
  writeFileSync(OUT_FILE, [header, ...rows].join("\n"));

  console.log(`\nSaved ${candles.length} candles to ${OUT_FILE}`);
  if (candles.length) console.log(`Range: ${candles[0].date} → ${candles[candles.length - 1].date}`);
  console.log(`\nBacktest it with:\n  node daily-range-breakout.js ${OUT_FILE}`);
}

fetchAll().catch(console.error);
