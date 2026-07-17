/**
 * fetch-history.js — pull full daily OHLCV history for a symbol from BitGet's
 * public market API (no auth) and write it as a CSV in the repo's standard
 * format (Date,Open,High,Low,Close,Volume).
 *
 * Built to run in GitHub Actions (see .github/workflows/fetch-history.yml):
 * Binance answers HTTP 451 from US-hosted CI runners, BitGet does not.
 *
 * Usage: node fetch-history.js SOLUSDT sol-daily-bitget.csv
 */

import { writeFileSync } from "fs";

const SYMBOL = process.argv[2] || "SOLUSDT";
const OUT = process.argv[3] || `${SYMBOL.toLowerCase()}-daily-bitget.csv`;
const BASE = process.env.BITGET_BASE_URL || "https://api.bitget.com";

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`BitGet ${path}: HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet ${path}: ${data.msg}`);
  return data.data;
}

const toRow = (k) => ({
  ts: +k[0],
  date: new Date(+k[0]).toISOString().slice(0, 10),
  open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
});

const byTs = new Map();

// recent candles first, then page backward through history-candles
const recent = await get(`/api/v2/spot/market/candles?symbol=${SYMBOL}&granularity=1day&limit=200`);
for (const k of recent) { const r = toRow(k); byTs.set(r.ts, r); }

let oldest = Math.min(...byTs.keys());
for (let page = 0; page < 60; page++) {
  const batch = await get(`/api/v2/spot/market/history-candles?symbol=${SYMBOL}&granularity=1day&endTime=${oldest - 1}&limit=200`);
  if (!batch.length) break;
  for (const k of batch) { const r = toRow(k); byTs.set(r.ts, r); }
  const newOldest = Math.min(...byTs.keys());
  if (newOldest === oldest) break;
  oldest = newOldest;
  process.stdout.write(`  back to ${new Date(oldest).toISOString().slice(0, 10)} (${byTs.size} candles)\r`);
  await new Promise((r) => setTimeout(r, 250));
}

const rows = [...byTs.values()].sort((a, b) => a.ts - b.ts);
// drop today's still-forming candle
if (rows.length && rows[rows.length - 1].date === new Date().toISOString().slice(0, 10)) rows.pop();

const csv = ["Date,Open,High,Low,Close,Volume",
  ...rows.map((r) => `${r.date},${r.open},${r.high},${r.low},${r.close},${r.volume}`)].join("\n");
writeFileSync(OUT, csv + "\n");
console.log(`\nSaved ${rows.length} candles to ${OUT} (${rows[0]?.date} -> ${rows[rows.length - 1]?.date})`);
