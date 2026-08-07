/**
 * Fetches stablecoin mint/burn events, disk-cached.
 *
 * Mechanism: USDT and USDC both emit a standard ERC-20 Transfer event when
 * new supply is created or destroyed — Transfer(0x0 -> treasury) for a mint,
 * Transfer(treasury -> 0x0) for a burn. This is the same heuristic
 * Whale-Alert-style trackers use. Querying Etherscan for token transfers
 * involving the null address, filtered to one contract, returns exactly
 * those events — a small, precise dataset, not the full transfer firehose.
 *
 * HONEST LIMITATION: this is Ethereum-only. The majority of USDT supply
 * actually lives on Tron, which isn't covered here (no free equivalent
 * wired up yet). Treat this as a partial view of stablecoin issuance, not
 * the whole picture — real Tron coverage would be the natural v2.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "cache");
const ETHERSCAN = "https://api.etherscan.io/api";
const NULL_ADDR = "0x0000000000000000000000000000000000000000";

const TOKENS = {
  USDT: { contract: "0xdAC17F958D2ee523a2206206994597C13D831ec", decimals: 6 },
  USDC: { contract: "0xA0b86991c6218B36C1D19D4a2e9Eb0cE3606eB48", decimals: 6 },
};

if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

function cachePath(name) {
  return join(CACHE_DIR, `${name}.json`);
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Etherscan request failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.status === "0" && json.message !== "No transactions found") {
    throw new Error(`Etherscan API error: ${json.message} — ${json.result}`);
  }
  return json;
}

/** Mint/burn events for one token, oldest -> newest. */
async function fetchTokenMintBurnEvents(symbol, apiKey) {
  const { contract, decimals } = TOKENS[symbol];
  const out = [];
  let page = 1;
  const offset = 1000;

  while (true) {
    const url = `${ETHERSCAN}/api?module=account&action=tokentx&contractaddress=${contract}&address=${NULL_ADDR}&sort=asc&page=${page}&offset=${offset}&apikey=${apiKey}`;
    const json = await getJson(url);
    const batch = Array.isArray(json.result) ? json.result : [];
    if (!batch.length) break;

    for (const tx of batch) {
      const amount = parseFloat(tx.value) / 10 ** decimals;
      if (tx.from.toLowerCase() === NULL_ADDR) {
        out.push({ time: parseInt(tx.timeStamp, 10) * 1000, symbol, type: "mint", amount });
      } else if (tx.to.toLowerCase() === NULL_ADDR) {
        out.push({ time: parseInt(tx.timeStamp, 10) * 1000, symbol, type: "burn", amount: -amount });
      }
    }

    if (batch.length < offset) break;
    page++;
    await sleep(250);
    if (page > 50) break; // safety cap — this dataset should be small
  }

  return out;
}

/**
 * Combined USDT + USDC mint/burn event history.
 * Throws clearly if ETHERSCAN_API_KEY isn't set (free key — see README).
 */
export async function fetchStablecoinMintEvents() {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ETHERSCAN_API_KEY not set. Get a free key at https://etherscan.io/apis and add it to .env"
    );
  }

  return cached("mint-events-usdt-usdc", 60 * 60 * 1000, async () => {
    const [usdt, usdc] = await Promise.all([
      fetchTokenMintBurnEvents("USDT", apiKey),
      fetchTokenMintBurnEvents("USDC", apiKey),
    ]);
    return [...usdt, ...usdc].sort((a, b) => a.time - b.time);
  });
}
