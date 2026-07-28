// Fetch hourly (or any interval) OHLCV candles from Binance -> CSV
// for the London->New York session study. Same style as ../../fetch-binance.js.
//
//   node fetch-hourly.js [SYMBOL] [INTERVAL] [START_DATE]
//   node fetch-hourly.js BTCUSDT 1h 2019-01-01
//   node fetch-hourly.js SOLUSDT 1h 2021-01-01
//
// Output: <SYMBOL>-<INTERVAL>.csv with header  timestamp,open,high,low,close,volume
// (timestamp = unix ms, UTC). Runs where Binance is reachable (your machine /
// Railway) — not needed inside the analysis, which reads the CSV offline.
import { writeFileSync } from "fs";
import https from "https";

const SYMBOL   = process.argv[2] || "BTCUSDT";
const INTERVAL = process.argv[3] || "1h";
const START    = new Date(process.argv[4] || "2019-01-01").getTime();
const LIMIT    = 1000; // max klines per request
const OUT_FILE = `${SYMBOL}-${INTERVAL}.csv`;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = "";
      res.on("data", d => (data += d));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(data.slice(0, 200))); }
      });
    }).on("error", reject);
  });
}

async function fetchAll() {
  const rows = [];
  let endTime = Date.now();
  console.log(`Fetching ${SYMBOL} ${INTERVAL} candles from Binance back to ${new Date(START).toISOString().slice(0,10)}...`);

  while (endTime > START) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${LIMIT}&endTime=${endTime}`;
    const batch = await get(url);
    if (!Array.isArray(batch) || !batch.length) break;

    for (const k of batch) {
      rows.push([k[0], k[1], k[2], k[3], k[4], k[5]].join(",")); // openTime,o,h,l,c,vol
    }
    endTime = batch[0][0] - 1; // step back before the earliest candle in this batch
    process.stdout.write(`  ...${new Date(batch[0][0]).toISOString().slice(0, 10)}\r`);
    await new Promise(r => setTimeout(r, 250)); // be polite to the API
  }

  // de-dupe + sort oldest -> newest by timestamp
  const seen = new Set();
  const clean = rows.filter(r => { const t = r.split(",")[0]; if (seen.has(t)) return false; seen.add(t); return true; })
                    .sort((a, b) => Number(a.split(",")[0]) - Number(b.split(",")[0]));

  writeFileSync(OUT_FILE, ["timestamp,open,high,low,close,volume", ...clean].join("\n"));
  console.log(`\nSaved ${clean.length} candles to ${OUT_FILE}`);
  console.log(`Range: ${new Date(+clean[0].split(",")[0]).toISOString()} -> ${new Date(+clean[clean.length-1].split(",")[0]).toISOString()}`);
}

fetchAll().catch(e => { console.error("fetch failed:", e.message); process.exit(1); });
