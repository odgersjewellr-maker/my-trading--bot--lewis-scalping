import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { fetchExchangeFlowEvents } from "./mempoolData.js";
import { BTC_EXCHANGE_WALLETS } from "./knownWallets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "cache");
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

export async function fetchWatchedWalletFlows(days) {
  return cached(`flows-${days}d`, 60 * 60 * 1000, () => fetchExchangeFlowEvents(BTC_EXCHANGE_WALLETS, days));
}
