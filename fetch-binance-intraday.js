/**
 * Fetch intraday candles from Binance for scalp backtesting.
 * Usage: node fetch-binance-intraday.js [symbol] [interval] [days]
 *   e.g. node fetch-binance-intraday.js BTCUSDT 1m 30
 *
 * Writes <symbol>-<interval>-binance.csv (oldest first) in the repo dir.
 * Note: Binance may be unreachable from some cloud sandboxes — run this
 * locally or on your VPS, then commit the CSV.
 */

import { writeFileSync } from "fs";
import https from "https";

const SYMBOL   = process.argv[2] || "BTCUSDT";
const INTERVAL = process.argv[3] || "1m";
const DAYS     = parseInt(process.argv[4] || "30", 10);
const LIMIT    = 1000;
const OUT_FILE = `${SYMBOL.toLowerCase()}-${INTERVAL}-binance.csv`;

const MS_PER = { "1m": 60e3, "3m": 180e3, "5m": 300e3, "15m": 900e3, "30m": 1800e3, "1h": 3600e3 };
if (!MS_PER[INTERVAL]) {
  console.error(`Unsupported interval "${INTERVAL}" — use one of: ${Object.keys(MS_PER).join(", ")}`);
  process.exit(1);
}

// api.binance.com geo-blocks some regions (e.g. US cloud IPs);
// data-api.binance.vision is Binance's public market-data mirror without the block.
const HOSTS = ["api.binance.com", "data-api.binance.vision"];
let hostIdx = 0;

function get(path) {
  return new Promise((resolve, reject) => {
    const url = `https://${HOSTS[hostIdx]}${path}`;
    https.get(url, res => {
      let data = "";
      res.on("data", d => (data += d));
      res.on("end", () => {
        if (res.statusCode !== 200 && hostIdx < HOSTS.length - 1) {
          hostIdx++;
          console.log(`\n  ${HOSTS[hostIdx - 1]} returned ${res.statusCode} — switching to ${HOSTS[hostIdx]}`);
          return get(path).then(resolve, reject);
        }
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Bad response (${res.statusCode}): ${data.slice(0, 200)}`)); }
      });
      res.on("error", reject);
    }).on("error", err => {
      if (hostIdx < HOSTS.length - 1) { hostIdx++; get(path).then(resolve, reject); }
      else reject(err);
    });
  });
}

async function fetchAll() {
  const candles = [];
  const earliest = Date.now() - DAYS * 86400e3;
  let endTime = Date.now();

  console.log(`Fetching ${SYMBOL} ${INTERVAL} candles for the last ${DAYS} days...`);

  while (endTime > earliest) {
    const batch = await get(`/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${LIMIT}&endTime=${endTime}`);
    if (!Array.isArray(batch) || !batch.length) break;

    for (const k of batch) {
      candles.push({
        ts: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      });
    }

    endTime = batch[0][0] - 1;
    process.stdout.write(`  fetched back to ${new Date(batch[0][0]).toISOString()}\r`);
    await new Promise(r => setTimeout(r, 250));
  }

  const seen = new Set();
  const unique = candles.filter(c => !seen.has(c.ts) && seen.add(c.ts) && c.ts >= earliest);
  unique.sort((a, b) => a.ts - b.ts);

  const header = "Timestamp,Open,High,Low,Close,Volume";
  const rows = unique.map(c => `${new Date(c.ts).toISOString()},${c.open},${c.high},${c.low},${c.close},${c.volume}`);
  writeFileSync(OUT_FILE, [header, ...rows].join("\n"));

  console.log(`\nSaved ${unique.length} candles to ${OUT_FILE}`);
  console.log(`Range: ${rows[0]?.split(",")[0]} → ${rows[rows.length - 1]?.split(",")[0]}`);
  console.log(`Next: node backtest-scalp.js ${OUT_FILE}`);
}

fetchAll().catch(e => { console.error("Fetch failed:", e.message); process.exit(1); });
