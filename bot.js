/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on a schedule (e.g. GitHub Actions). Pulls candle data
 * from BitGet's public market-data endpoint (free, no auth — Binance's
 * equivalent endpoint returns HTTP 451 from US-hosted CI runners), calculates
 * all indicators, runs safety check, executes via BitGet if everything lines up.
 *
 * Local mode: run manually — node bot.js
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import { pathToFileURL } from "url";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=4H",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your BitGet credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

export const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  tradeSizePct: parseFloat(process.env.TRADE_SIZE_PCT || "80") / 100,
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "5000"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  // Sent to BitGet as presetStopLossPrice on the entry order itself (see
  // computeStopLossPrice) — enforced by the exchange on real trades, not by us.
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "0.3"),
  atrPeriod: parseInt(process.env.ATR_PERIOD || "14"),
  // Futures only. Left unset, BitGet falls back to whatever leverage is
  // already configured on the account for this symbol — explicit here so
  // it's never a surprise.
  leverage: parseInt(process.env.LEVERAGE || "1", 10),
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

export const LOG_FILE = "safety-check-log.json";
export const POSITION_FILE = "position.json";
export const PORTFOLIO_FILE = "portfolio.json";
export const STATE_FILE = "nkb-state.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.type === "entry" && t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Position State (persisted between cron runs) ───────────────────────────

export function loadPosition() {
  if (!existsSync(POSITION_FILE)) return null;
  const raw = JSON.parse(readFileSync(POSITION_FILE, "utf8"));
  return raw === null ? null : raw;
}

function savePosition(position) {
  writeFileSync(POSITION_FILE, JSON.stringify(position, null, 2));
}

function loadPortfolio() {
  if (!existsSync(PORTFOLIO_FILE)) return CONFIG.portfolioValue;
  return JSON.parse(readFileSync(PORTFOLIO_FILE, "utf8")).value;
}

function savePortfolio(value) {
  writeFileSync(PORTFOLIO_FILE, JSON.stringify({ value, updatedAt: new Date().toISOString() }, null, 2));
}

// Persists the NKB band state (1=bullish, -1=bearish, 0=neutral) between runs
// so Buy/Sell labels only fire on genuine bearish↔bullish transitions, exactly
// matching what the Pine Script indicator shows on the chart.
function loadNKBState() {
  if (!existsSync(STATE_FILE)) return 0;
  return JSON.parse(readFileSync(STATE_FILE, "utf8")).state ?? 0;
}

function saveNKBState(state) {
  writeFileSync(STATE_FILE, JSON.stringify({ state, updatedAt: new Date().toISOString() }, null, 2));
}

// ─── Market Data (BitGet public API — free, no auth) ────────────────────────

export async function fetchCandles(symbol, interval, limit = 100) {
  // Map our timeframe format to BitGet granularity format
  const granularityMap = {
    "1m": "1min",
    "3m": "3min",
    "5m": "5min",
    "15m": "15min",
    "30m": "30min",
    "1H": "1h",
    "4H": "4h",
    "1D": "1day",
    "1W": "1week",
  };
  const granularity = granularityMap[interval] || "1min";

  const url = `${CONFIG.bitget.baseUrl}/api/v2/spot/market/candles?symbol=${symbol}&granularity=${granularity}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BitGet candles API error: ${res.status}`);
  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet candles API error: ${data.msg}`);

  // BitGet returns oldest-first, same ordering Binance used — no resort needed
  return data.data.map((k) => ({
    time: parseInt(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Neural Kernel Bands — Indicator Calculations ────────────────────────────

const NKB = {
  length:      parseInt(process.env.NKB_LENGTH      || "30"),
  bandwidth:   parseFloat(process.env.NKB_BANDWIDTH  || "8.0"),
  adaptive:    process.env.NKB_ADAPTIVE !== "false",
  atrLen:      parseInt(process.env.NKB_ATR_LEN     || "14"),
  smooth:      parseInt(process.env.NKB_SMOOTH       || "3"),
  bandMult:    parseFloat(process.env.NKB_BAND_MULT  || "1.0"),
  bandLen:     parseInt(process.env.NKB_BAND_LEN     || "24"),
  bandSmooth:  parseInt(process.env.NKB_BAND_SMOOTH  || "5"),
  // gaussian (infinite tail, smoothest/laggiest) | epanechnikov (compact support,
  // hard cutoff, most reactive) | tricube (compact support, smooth taper — a
  // middle ground between the other two). See KERNELS below for the math.
  kernel:      (process.env.NKB_KERNEL || "gaussian").toLowerCase(),
};

// u = distance-from-current-bar / bandwidth. Gaussian never reaches zero so every
// bar in the fetched window still has some pull; the other two are zero past u=1,
// so they only look back roughly one bandwidth's worth of bars.
const KERNELS = {
  gaussian: (j, h) => Math.exp(-(j * j) / (2 * h * h)),
  epanechnikov: (j, h) => {
    const u = j / h;
    return Math.abs(u) > 1 ? 0 : 0.75 * (1 - u * u);
  },
  tricube: (j, h) => {
    const u = j / h;
    return Math.abs(u) > 1 ? 0 : (1 - Math.abs(u) ** 3) ** 3;
  },
};
if (!KERNELS[NKB.kernel]) {
  throw new Error(`Unknown NKB_KERNEL "${NKB.kernel}" — expected gaussian, epanechnikov, or tricube`);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// Wilder's RMA-smoothed ATR series, matching Pine's ta.atr() exactly —
// seeded with a simple average of the first `period` true ranges, then
// each subsequent value is a recursive (period-1)/period-weighted average.
function calcATRSeries(candles, period) {
  const n = candles.length;
  const tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  const atr = new Array(n).fill(null);
  if (n <= period) return atr;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

// EMA series matching Pine's ta.ema() — seeds on the first non-null value
// (no SMA pre-seed), then recurses with alpha = 2/(period+1).
function calcEMASeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let ema = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    ema = ema == null ? v : v * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

// Population standard deviation over a trailing window, matching ta.stdev().
function calcStddevSeries(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1).map((v) => v ?? 0);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

// Faithful port of the Neural Kernel Bands [JOAT] Pine script. Replays the
// full fetched window so `lastState` ends up exactly where the indicator's
// persistent `var int lastState` would be — it only flips on a genuine
// opposite-band close, not on every dip back inside the bands.
function calcNKB(candles) {
  const closes = candles.map((c) => c.close);
  const n = closes.length;

  const atrArr = calcATRSeries(candles, NKB.atrLen);
  const atrNorm = atrArr.map((a, i) => (a != null ? a / closes[i] : null));
  const atrFactor = calcEMASeries(atrNorm, NKB.atrLen);

  const h = atrFactor.map((f) =>
    NKB.bandwidth * (NKB.adaptive ? 1 + (f ?? 0) * 200 : 1),
  );

  // Nadaraya-Watson kernel regression — computed at every bar
  const kernelFn = KERNELS[NKB.kernel];
  const nwRaw = new Array(n);
  for (let i = 0; i < n; i++) {
    const hi = h[i];
    let sumW = 0, sumWC = 0;
    const lookback = Math.min(NKB.length, i + 1);
    for (let j = 0; j < lookback; j++) {
      const kw = kernelFn(j, hi);
      sumWC += kw * closes[i - j];
      sumW  += kw;
    }
    nwRaw[i] = sumW > 0 ? sumWC / sumW : closes[i];
  }

  const kernelArr = calcEMASeries(nwRaw, NKB.smooth);
  const residuals = closes.map((c, i) => (kernelArr[i] != null ? c - kernelArr[i] : null));
  const sigmaRawArr = calcStddevSeries(residuals, NKB.bandLen);
  const sigmaArr = calcEMASeries(sigmaRawArr, NKB.bandSmooth);

  const upperBand = new Array(n).fill(null);
  const lowerBand = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (kernelArr[i] == null || sigmaArr[i] == null) continue;
    upperBand[i] = kernelArr[i] + NKB.bandMult * sigmaArr[i];
    lowerBand[i] = kernelArr[i] - NKB.bandMult * sigmaArr[i];
  }

  // Sticky state replay — matches `if close > upperBand: lastState := 1
  // else if close < lowerBand: lastState := -1` (unchanged otherwise).
  let lastState = 0;
  for (let i = 0; i < n; i++) {
    if (upperBand[i] == null || lowerBand[i] == null) continue;
    if (closes[i] > upperBand[i]) lastState = 1;
    else if (closes[i] < lowerBand[i]) lastState = -1;
  }

  const last = n - 1;
  return {
    kernelMA: kernelArr[last],
    sigma: sigmaArr[last],
    upperBand: upperBand[last],
    lowerBand: lowerBand[last],
    state: lastState,
  };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);
  const noDailyLimit = CONFIG.maxTradesPerDay <= 0;

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (!noDailyLimit && todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    noDailyLimit
      ? `✅ Trades today: ${todayCount} — no daily limit set`
      : `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

export function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

// BitGet's preset stop-loss only makes sense on the *entry* order — a
// reversal/close order should never carry one. positionSide is "long"/"short".
export function computeStopLossPrice(positionSide, entryPrice) {
  return positionSide === "long"
    ? entryPrice * (1 - CONFIG.stopLossPct / 100)
    : entryPrice * (1 + CONFIG.stopLossPct / 100);
}

// Isolated margin sets leverage per holdSide ("long"/"short"), so it must be
// called for the side we're about to open before placeOrder — otherwise
// BitGet uses whatever leverage was last set (or the account default) for
// that side, which may not match CONFIG.leverage.
export async function setLeverage(symbol, holdSide) {
  const timestamp = Date.now().toString();
  const path = "/api/v2/mix/account/set-leverage";
  const body = JSON.stringify({
    symbol,
    productType: "USDT-FUTURES",
    marginCoin: "USDT",
    leverage: String(CONFIG.leverage),
    holdSide,
  });
  const signature = signBitGet(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet set-leverage failed: ${data.msg}`);
  }
}

async function placeBitGetOrder(symbol, side, quantity, stopLossPrice, positionSide) {
  const qty = parseFloat(quantity).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  if (CONFIG.tradeMode === "futures" && positionSide) {
    await setLeverage(symbol, positionSide);
  }

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity: qty,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
      ...(stopLossPrice && { presetStopLossPrice: stopLossPrice.toFixed(2) }),
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }

  return data.data;
}

// Executes (or, in paper mode, simulates) a single order. Used for both
// opening and closing positions — `side` is "buy" or "sell". `positionSide`
// ("long"/"short") is only passed when opening a new position, so leverage
// gets (re)set for that holdSide; closing an existing position reuses
// whatever leverage it was opened with.
async function executeOrder(side, quantity, stopLossPrice, positionSide) {
  if (CONFIG.paperTrading) {
    return { orderId: `PAPER-${Date.now()}`, paper: true };
  }
  const order = await placeBitGetOrder(CONFIG.symbol, side, quantity, stopLossPrice, positionSide);
  return { orderId: order.orderId, paper: false };
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

export const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeCsvRow({ side = "", quantity = "", price, totalUSD = "", orderId = "", mode, notes = "" }) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  const fee = totalUSD !== "" ? (parseFloat(totalUSD) * 0.001).toFixed(4) : "";
  const netAmount =
    totalUSD !== "" && fee !== "" ? (parseFloat(totalUSD) - parseFloat(fee)).toFixed(2) : "";

  const row = [
    date,
    time,
    "BitGet",
    CONFIG.symbol,
    side,
    quantity,
    price !== undefined ? price.toFixed(2) : "",
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  console.log(`\nStrategy: Neural Kernel Bands (NKB)`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  console.log("\n── Fetching market data from BitGet ─────────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const atr = calcATR(candles, CONFIG.atrPeriod);

  console.log(`  Current price: $${price.toFixed(2)}`);

  const nkb = calcNKB(candles);
  console.log(`  Kernel MA:    $${nkb.kernelMA.toFixed(2)}`);
  console.log(`  Upper Band:   $${nkb.upperBand.toFixed(2)}`);
  console.log(`  Lower Band:   $${nkb.lowerBand.toFixed(2)}`);
  console.log(`  Band σ:       $${nkb.sigma.toFixed(2)}`);
  console.log(`  State:        ${nkb.state === 1 ? "BULLISH" : nkb.state === -1 ? "BEARISH" : "NEUTRAL"}`);
  console.log(`  ATR(${CONFIG.atrPeriod}):      ${atr ? "$" + atr.toFixed(2) : "N/A"}`);

  const log = loadLog();
  let position = loadPosition();
  let portfolioValue = loadPortfolio();

  // nkb.state is now a sticky replay of the indicator's persistent lastState
  // (see calcNKB) — it only changes on a genuine opposite-band close, same as
  // the Pine script. We still track the previously-saved state across runs so
  // we only act once per transition instead of re-firing every 5 minutes.
  const prevNKBState = loadNKBState();
  const buySignal  = nkb.state === 1  && prevNKBState !== 1;
  const sellSignal = nkb.state === -1 && prevNKBState !== -1;
  saveNKBState(nkb.state);

  const stateLabel = nkb.state === 1 ? "BULLISH" : nkb.state === -1 ? "BEARISH" : "NEUTRAL";
  console.log(`\n  Portfolio value: $${portfolioValue.toFixed(2)}`);
  console.log(`  NKB state: ${stateLabel} (prev: ${prevNKBState === 1 ? "BULLISH" : prevNKBState === -1 ? "BEARISH" : "NEUTRAL"})${buySignal ? " → 🟢 BUY SIGNAL" : sellSignal ? " → 🔴 SELL SIGNAL" : ""}`);

  // ── Manage an existing open position — NKB reversal closes it then flips ───
  if (position) {
    const crossExit = position.side === "long" ? sellSignal : buySignal;

    console.log("\n── Position Management ──────────────────────────────────\n");
    console.log(`  Side: ${position.side.toUpperCase()} | Entry: $${position.entryPrice.toFixed(2)} | Current: $${price.toFixed(2)}`);

    const pnlUSD = position.side === "long"
      ? (price - position.entryPrice) * position.quantity
      : (position.entryPrice - price) * position.quantity;
    const pnlPct = (pnlUSD / position.sizeUSD) * 100;
    console.log(`  Unrealized P&L: $${pnlUSD.toFixed(2)} (${pnlPct.toFixed(2)}%)`);

    if (crossExit) {
      const closeSide = position.side === "long" ? "sell" : "buy";
      console.log(`  NKB reversal signal — closing position`);
      console.log(`\n${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"} CLOSE — ${closeSide.toUpperCase()} ${position.quantity} ${CONFIG.symbol} at ~$${price.toFixed(2)}`);

      let order;
      try {
        order = await executeOrder(closeSide, position.quantity);
      } catch (err) {
        console.log(`❌ CLOSE FAILED — ${err.message}`);
        log.trades.push({ timestamp: new Date().toISOString(), type: "exit", symbol: CONFIG.symbol, side: closeSide, orderPlaced: false, error: err.message, paperTrading: CONFIG.paperTrading });
        saveLog(log);
        return;
      }

      portfolioValue = portfolioValue + pnlUSD;
      savePortfolio(portfolioValue);
      console.log(`  Portfolio updated: $${portfolioValue.toFixed(2)} (${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(2)})`);

      log.trades.push({ timestamp: new Date().toISOString(), type: "exit", symbol: CONFIG.symbol, side: closeSide, quantity: position.quantity, price, sizeUSD: position.sizeUSD, pnlUSD, pnlPct, reason: "NKB reversal", orderPlaced: true, orderId: order.orderId, paperTrading: CONFIG.paperTrading });
      saveLog(log);
      writeCsvRow({ side: closeSide.toUpperCase(), quantity: position.quantity, price, totalUSD: position.sizeUSD, orderId: order.orderId, mode: CONFIG.paperTrading ? "PAPER" : "LIVE", notes: `NKB reversal exit — P&L $${pnlUSD.toFixed(2)} (${pnlPct.toFixed(2)}%) | Portfolio: $${portfolioValue.toFixed(2)}` });
      savePosition(null);
      position = null;
      console.log(`\n✅ Position closed — now opening new position in opposite direction`);
      // Fall through to entry logic below to immediately open the flip trade
    } else {
      savePosition(position);
      console.log("  ✅ Holding — waiting for NKB reversal signal");
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }
  }

  // ── No open position — look for a new NKB entry ───────────────────────────
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    console.log("═══════════════════════════════════════════════════════════\n");
    return;
  }

  console.log("\n── NKB Signal ───────────────────────────────────────────\n");

  const canShort = CONFIG.tradeMode === "futures";
  // CONFIG.tradeSizePct of current portfolio value, re-evaluated each trade
  const tradeSize = portfolioValue * CONFIG.tradeSizePct;

  async function openPosition(side, positionSide, signalNote) {
    const quantity = parseFloat((tradeSize / price).toFixed(6));
    const stopLossPrice = computeStopLossPrice(positionSide, price);
    console.log(`✅ ${side.toUpperCase()} SIGNAL — ${signalNote}`);
    console.log(`   Trade size: $${tradeSize.toFixed(2)} (${(CONFIG.tradeSizePct * 100).toFixed(0)}% of $${portfolioValue.toFixed(2)})`);
    console.log(`   Stop loss: $${stopLossPrice.toFixed(2)} (${CONFIG.stopLossPct}%)`);
    console.log(`\n${CONFIG.paperTrading ? "📋 PAPER TRADE" : "🔴 PLACING LIVE ORDER"} — ${side.toUpperCase()} ~$${tradeSize.toFixed(2)} ${CONFIG.symbol}`);
    if (CONFIG.paperTrading) console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);

    let order;
    try {
      order = await executeOrder(side, quantity, stopLossPrice, positionSide);
    } catch (err) {
      console.log(`❌ ORDER FAILED — ${err.message}`);
      log.trades.push({ timestamp: new Date().toISOString(), type: "entry", symbol: CONFIG.symbol, price, nkb, orderPlaced: false, error: err.message, paperTrading: CONFIG.paperTrading });
      saveLog(log);
      writeCsvRow({ price, orderId: "FAILED", mode: "BLOCKED", notes: `Order failed: ${err.message}` });
      return;
    }

    savePosition({ side: positionSide, entryPrice: price, quantity, sizeUSD: tradeSize, stopLossPrice, openedAt: new Date().toISOString(), orderId: order.orderId });
    log.trades.push({ timestamp: new Date().toISOString(), type: "entry", symbol: CONFIG.symbol, side, quantity, price, sizeUSD: tradeSize, portfolioValue, nkb, orderPlaced: true, orderId: order.orderId, paperTrading: CONFIG.paperTrading });
    saveLog(log);
    writeCsvRow({ side: side.toUpperCase(), quantity, price, totalUSD: tradeSize, orderId: order.orderId, mode: CONFIG.paperTrading ? "PAPER" : "LIVE", notes: `NKB ${signalNote} | Portfolio: $${portfolioValue.toFixed(2)}` });
    console.log(`✅ ${positionSide} opened — exits on next NKB reversal signal only`);
  }

  if (buySignal) {
    await openPosition("buy", "long", "NKB Buy — bands flipped bullish");
  } else if (sellSignal && canShort) {
    await openPosition("sell", "short", "NKB Sell — bands flipped bearish");
  } else if (sellSignal && !canShort) {
    console.log("🚫 SELL SIGNAL — spot mode can't short. Set TRADE_MODE=futures in .env to enable.");
    writeCsvRow({ price, orderId: "BLOCKED", mode: "BLOCKED", notes: "NKB Sell — shorting unavailable in spot mode" });
  } else {
    console.log(`  No signal — ${stateLabel.toLowerCase()}, waiting for band flip`);
    // No CSV row written — would flood the file every 5 minutes with no-signal noise
  }

  console.log("═══════════════════════════════════════════════════════════\n");
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  if (process.argv.includes("--tax-summary")) {
    generateTaxSummary();
  } else {
    run().catch((err) => {
      console.error("Bot error:", err);
      process.exit(1);
    });
  }
}
