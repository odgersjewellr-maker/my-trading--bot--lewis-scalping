import { writeFileSync } from "fs";
import https from "https";

const SYMBOL   = "BTCUSDT";
const INTERVAL = "1d";
const LIMIT    = 1000; // max per request
const OUT_FILE = "btc-daily-binance.csv";

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
  const earliest = new Date("2019-01-01").getTime();

  console.log("Fetching BTCUSDT daily candles from Binance...");

  while (endTime > earliest) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${LIMIT}&endTime=${endTime}`;
    const batch = await get(url);
    if (!batch.length) break;

    for (const k of batch) {
      const ts   = k[0];
      const open  = parseFloat(k[1]);
      const high  = parseFloat(k[2]);
      const low   = parseFloat(k[3]);
      const close = parseFloat(k[4]);
      const vol   = parseFloat(k[5]);
      const date  = new Date(ts).toISOString().slice(0, 10);
      candles.push({ date, open, high, low, close, volume: vol });
    }

    endTime = batch[0][0] - 1; // step back before earliest candle in batch
    process.stdout.write(`  fetched up to ${new Date(batch[0][0]).toISOString().slice(0,10)}\r`);

    await new Promise(r => setTimeout(r, 250)); // rate limit
  }

  // sort oldest → newest
  candles.sort((a, b) => a.date.localeCompare(b.date));

  const header = "Date,Open,High,Low,Close,Volume";
  const rows = candles.map(c =>
    `${c.date},${c.open},${c.high},${c.low},${c.close},${c.volume}`
  );
  writeFileSync(OUT_FILE, [header, ...rows].join("\n"));

  console.log(`\nSaved ${candles.length} candles to ${OUT_FILE}`);
  console.log(`Range: ${candles[0].date} → ${candles[candles.length-1].date}`);
}

fetchAll().catch(console.error);
