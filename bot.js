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
  riskPct: parseFloat(process.env.RISK_PCT || "5") / 100, // % of portfolio to risk per trade (stop-loss basis)
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "5000"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  // Paper mode only — estimated taker fee + slippage deducted per side so paper
  // P&L tracks what live-money results would be (live fees come from the exchange).
  paperFeeRate: parseFloat(process.env.PAPER_FEE_RATE || "0.0008"),
  // Regime gate (idea #1 backtest, trading-firm institutional memory 2026-07-02):
  // "off" | "chop" | "markov" | "chop+markov". Blocks NEW entries (incl. re-entries)
  // in choppy/sideways regimes; never blocks exits.
  regimeGate: (process.env.REGIME_GATE || "off").toLowerCase(),
  // Prop mode — challenge risk architecture, Board-approved 2026-07-02.
  // Validated in trading-firm/backtests/prop-challenge-sim.mjs (+ Breakout variant).
  propMode: process.env.PROP_MODE === "true",
  propRiskPct: parseFloat(process.env.PROP_RISK_PCT || "1.0"),            // % of INITIAL balance risked per trade
  propTargetPct: parseFloat(process.env.PROP_TARGET_PCT || "10"),         // profit target, closed-balance basis
  propMaxDdPct: parseFloat(process.env.PROP_MAX_DD_PCT || "6"),           // firm max drawdown (equity, static)
  propDdGuard: parseFloat(process.env.PROP_DD_GUARD || "0.9"),            // flatten+halt at this fraction of max DD
  propDailyLimitPct: parseFloat(process.env.PROP_DAILY_LIMIT_PCT || "0"), // 0 = firm has no daily loss rule
  propDailyGuard: parseFloat(process.env.PROP_DAILY_GUARD || "0.7"),      // flatten+halt day at this fraction of daily limit
  propLevCap: parseFloat(process.env.PROP_LEV_CAP || "2"),                // firm notional leverage cap
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

// INSTANCE_ID lets multiple books trade the same symbol without sharing state
// (e.g. the SOLUSDT live-paper book and the SOLUSDT-PROP challenge book).
const FILE_KEY = process.env.INSTANCE_ID || CONFIG.symbol;
export const LOG_FILE        = `safety-check-log-${FILE_KEY}.json`;
export const POSITION_FILE   = `position-${FILE_KEY}.json`;
export const PORTFOLIO_FILE  = `portfolio-${FILE_KEY}.json`;
export const STATE_FILE      = `nkb-state-${FILE_KEY}.json`;
export const PROP_STATE_FILE = `prop-state-${FILE_KEY}.json`;

function loadPropState() {
  if (!existsSync(PROP_STATE_FILE)) return null;
  return JSON.parse(readFileSync(PROP_STATE_FILE, "utf8"));
}
function savePropState(p) {
  writeFileSync(PROP_STATE_FILE, JSON.stringify(p, null, 2));
}

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

// Choppiness Index over the last `period` completed candles: 100 = pure chop, 0 = pure trend
export function calcChop(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const seg = candles.slice(-(period + 1));
  let sumTR = 0, hi = -Infinity, lo = Infinity;
  for (let i = 1; i < seg.length; i++) {
    const c = seg[i], p = seg[i - 1];
    sumTR += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (c.high > hi) hi = c.high;
    if (c.low < lo) lo = c.low;
  }
  if (hi - lo <= 0 || sumTR <= 0) return null;
  return 100 * Math.log10(sumTR / (hi - lo)) / Math.log10(period);
}

// ─── Neural Kernel Bands — Indicator Calculations ────────────────────────────

const NKB = {
  length:         parseInt(process.env.NKB_LENGTH       || "30"),
  bandwidth:      parseFloat(process.env.NKB_BANDWIDTH   || "6.0"),
  adaptive:       process.env.NKB_ADAPTIVE !== "false",
  atrLen:         parseInt(process.env.NKB_ATR_LEN      || "14"),
  smooth:         parseInt(process.env.NKB_SMOOTH        || "3"),
  bandMult:       parseFloat(process.env.NKB_BAND_MULT   || "3.0"), // 3σ — optimised: fewer trades, 44% win rate, PF 6.23
  bandLen:        parseInt(process.env.NKB_BAND_LEN      || "24"),
  bandSmooth:     parseInt(process.env.NKB_BAND_SMOOTH   || "5"),
  volumeWeighted: process.env.NKB_VOLUME_WEIGHTED !== "false",       // weight kernel by bar volume
  volumeFilter:   parseFloat(process.env.NKB_VOLUME_FILTER || "0.8"), // skip if vol < SMA×this
  volumeSMA:      parseInt(process.env.NKB_VOLUME_SMA    || "20"),   // bars for volume SMA
  atrStopMult:    parseFloat(process.env.NKB_ATR_STOP_MULT || "1.0"), // dynamic stop = ATR × this
  kernel:         (process.env.NKB_KERNEL || "gaussian").toLowerCase(),
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

// ADX (Wilder smoothing) — returns final ADX value for the last candle
function calcADX(candles, period = 14) {
  const n = candles.length;
  if (n < period * 2) return null;
  const plusDM = [], minusDM = [], tr = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high, dn = p.low - c.low;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
  }
  // initial Wilder sum
  let smTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let smP  = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smM  = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  const dx = [];
  for (let i = period; i < tr.length; i++) {
    smTR = smTR - smTR / period + tr[i];
    smP  = smP  - smP  / period + plusDM[i];
    smM  = smM  - smM  / period + minusDM[i];
    const pdi = smTR ? 100 * smP / smTR : 0;
    const mdi = smTR ? 100 * smM / smTR : 0;
    dx.push((pdi + mdi) > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  }
  // ADX = Wilder smooth of DX
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
  return adx;
}

// Faithful port of the Neural Kernel Bands [JOAT] Pine script. Replays the
// full fetched window so `lastState` ends up exactly where the indicator's
// persistent `var int lastState` would be — it only flips on a genuine
// opposite-band close, not on every dip back inside the bands.
// Volume SMA — used by calcNKB volume filter and volume-weighted kernel
function calcVolumeSMA(candles, period) {
  return candles.map((_, i) => {
    if (i < period - 1) return null;
    const slice = candles.slice(i - period + 1, i + 1);
    return slice.reduce((s, c) => s + c.volume, 0) / period;
  });
}

function calcNKB(candles) {
  const closes  = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const n = closes.length;

  // Normalise volumes to [0,1] range so they act as weights without dominating
  const maxVol = Math.max(...volumes.filter(Boolean));
  const normVol = volumes.map((v) => (maxVol > 0 ? v / maxVol : 1));

  const atrArr = calcATRSeries(candles, NKB.atrLen);
  const atrNorm = atrArr.map((a, i) => (a != null ? a / closes[i] : null));
  const atrFactor = calcEMASeries(atrNorm, NKB.atrLen);

  const h = atrFactor.map((f) =>
    NKB.bandwidth * (NKB.adaptive ? 1 + (f ?? 0) * 200 : 1),
  );

  // Nadaraya-Watson kernel regression — optionally volume-weighted
  // High-volume bars pull the kernel line toward them more strongly,
  // anchoring the regression to price action that actually matters.
  const kernelFn = KERNELS[NKB.kernel];
  const nwRaw = new Array(n);
  for (let i = 0; i < n; i++) {
    const hi = h[i];
    let sumW = 0, sumWC = 0;
    const lookback = Math.min(NKB.length, i + 1);
    for (let j = 0; j < lookback; j++) {
      const kw = kernelFn(j, hi) * (NKB.volumeWeighted ? normVol[i - j] : 1);
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

export const CSV_FILE = `trades-${FILE_KEY}.csv`;

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

  // 4H MTF filter — only trade with the higher-timeframe trend
  const candles4h = await fetchCandles(CONFIG.symbol, "4H", 100);
  const nkb4h = calcNKB(candles4h);

  console.log(`  Current price: $${price.toFixed(2)}`);

  const nkb = calcNKB(candles);
  const adxValue = calcADX(candles, 14);
  const adxStrong = adxValue != null && adxValue >= 25;
  console.log(`  Kernel MA:    $${nkb.kernelMA.toFixed(2)}`);
  console.log(`  Upper Band:   $${nkb.upperBand.toFixed(2)}`);
  console.log(`  Lower Band:   $${nkb.lowerBand.toFixed(2)}`);
  console.log(`  Band σ:       $${nkb.sigma.toFixed(2)}`);
  console.log(`  State:        ${nkb.state === 1 ? "BULLISH" : nkb.state === -1 ? "BEARISH" : "NEUTRAL"}`);
  console.log(`  ADX(14):      ${adxValue != null ? adxValue.toFixed(1) : "N/A"}${adxStrong ? " 💪 STRONG TREND" : " (weak)"}`);
  console.log(`  ATR(${CONFIG.atrPeriod}):      ${atr ? "$" + atr.toFixed(2) : "N/A"}`);
  console.log(`  4H State:     ${nkb4h.state === 1 ? "🟢 BULLISH" : nkb4h.state === -1 ? "🔴 BEARISH" : "⚪ NEUTRAL"} (MTF filter)`);

  // ── Volume filter ──────────────────────────────────────────────────────────
  const volSMAArr  = calcVolumeSMA(candles, NKB.volumeSMA);
  const currentVol = candles[candles.length - 1].volume;
  const volSMA     = volSMAArr[volSMAArr.length - 1];
  const volOk      = volSMA == null || currentVol >= volSMA * NKB.volumeFilter;
  console.log(`  Volume:       ${currentVol.toFixed(2)} (SMA${NKB.volumeSMA}: ${volSMA?.toFixed(2) ?? "N/A"}) ${volOk ? "✅" : "🚫 LOW — no trade"}`);

  // ── ATR dynamic stop distance ──────────────────────────────────────────────
  const atrStopDist = atr ? atr * NKB.atrStopMult : null;

  const log = loadLog();
  let position = loadPosition();
  let portfolioValue = loadPortfolio();

  // Paper-mode fee: deduct estimated taker fee + slippage per side from the paper
  // portfolio so paper results don't overstate live-money results.
  const paperFee = (notional) => {
    if (!CONFIG.paperTrading || !notional || CONFIG.paperFeeRate <= 0) return;
    const fee = notional * CONFIG.paperFeeRate;
    portfolioValue -= fee;
    console.log(`  Paper fee: -$${fee.toFixed(2)} (${(CONFIG.paperFeeRate * 100).toFixed(2)}% of $${notional.toFixed(2)})`);
  };

  // nkb.state is now a sticky replay of the indicator's persistent lastState
  // (see calcNKB) — it only changes on a genuine opposite-band close, same as
  // the Pine script. We still track the previously-saved state across runs so
  // we only act once per transition instead of re-firing every 5 minutes.
  // Load full state file to track consecutive bars and pending signals
  const stateFile     = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  const prevNKBState  = stateFile.state ?? 0;
  const prevPending   = stateFile.pendingSignal ?? null; // "BUY" | "SELL" | null
  const pendingBars   = stateFile.pendingBars   ?? 0;

  const flippedBull = nkb.state === 1  && prevNKBState !== 1;
  const flippedBear = nkb.state === -1 && prevNKBState !== -1;

  // On a new flip, start a pending signal counter (1 bar so far).
  // If state holds from last run, increment the counter.
  // Fire the signal only once it has held for 2+ consecutive bars.
  let newPending   = prevPending;
  let newPendingBars = pendingBars;
  if (flippedBull)                        { newPending = "BUY";  newPendingBars = 1; }
  else if (flippedBear)                   { newPending = "SELL"; newPendingBars = 1; }
  else if (nkb.state === prevNKBState)    { newPendingBars = pendingBars + 1; }
  else                                    { newPending = null; newPendingBars = 0; }

  writeFileSync(STATE_FILE, JSON.stringify({
    state: nkb.state, pendingSignal: newPending, pendingBars: newPendingBars,
    updatedAt: new Date().toISOString(),
  }, null, 2));

  // 4H MTF: only trade with the higher-timeframe trend (neutral 4H allows both directions)
  const mtfOkLong  = nkb4h.state >= 0; // 4H bullish or neutral
  const mtfOkShort = nkb4h.state <= 0; // 4H bearish or neutral

  // Fire when signal confirmed 2+ bars, 4H aligned, AND volume is healthy
  const buySignal  = newPending === "BUY"  && newPendingBars >= 2 && volOk && mtfOkLong;
  const sellSignal = newPending === "SELL" && newPendingBars >= 2 && volOk && mtfOkShort;

  // ── Regime gate — blocks new entries (and re-entries) in chop/sideways; never exits
  let regimeAllows = true;
  let regimeNote = "off";
  if (CONFIG.regimeGate !== "off") {
    const parts = [];
    if (CONFIG.regimeGate.includes("chop")) {
      const candles1h = await fetchCandles(CONFIG.symbol, "1H", 40);
      const chopVal = calcChop(candles1h.slice(0, -1), 14); // completed 1H bars only
      const chopOk = chopVal == null || chopVal < 61.8;
      if (!chopOk) regimeAllows = false;
      parts.push(`CHOP(14,1H) ${chopVal != null ? chopVal.toFixed(1) : "N/A"} ${chopOk ? "<" : "≥"} 61.8`);
    }
    if (CONFIG.regimeGate.includes("markov")) {
      const daily = await fetchCandles(CONFIG.symbol, "1D", 30);
      const completed = daily.slice(0, -1); // exclude forming day
      if (completed.length >= 21) {
        const ret20 = completed[completed.length - 1].close / completed[completed.length - 21].close - 1;
        const trending = Math.abs(ret20) > 0.05; // Bull >+5% / Bear <−5%; Sideways blocks
        if (!trending) regimeAllows = false;
        parts.push(`20d ret ${(ret20 * 100).toFixed(1)}% ${trending ? "(trending)" : "(sideways)"}`);
      }
    }
    regimeNote = parts.join(" | ");
    console.log(`  Regime gate:  [${CONFIG.regimeGate}] ${regimeAllows ? "✅ entries allowed" : "🚦 entries blocked"} — ${regimeNote}`);
  }

  // ── Prop mode guards — run BEFORE any position management ──────────────────
  let prop = null;
  if (CONFIG.propMode) {
    prop = loadPropState() ?? {
      startedAt: new Date().toISOString(),
      initialBalance: portfolioValue,
      status: "active",
      dayDate: null,
      dayStartEquity: portfolioValue,
      dayHalted: false,
    };
    const initial = prop.initialBalance;
    const unreal = position
      ? (position.side === "long" ? (price - position.entryPrice) * position.quantity : (position.entryPrice - price) * position.quantity)
      : 0;
    let equity = portfolioValue + unreal;
    const today = new Date().toISOString().slice(0, 10);
    if (prop.dayDate !== today) { prop.dayDate = today; prop.dayStartEquity = equity; prop.dayHalted = false; }

    const targetAbs = initial * (1 + CONFIG.propTargetPct / 100);
    const firmFloor = initial * (1 - CONFIG.propMaxDdPct / 100);
    const guardFloor = initial * (1 - (CONFIG.propMaxDdPct / 100) * CONFIG.propDdGuard);

    // Flatten at market — used only by prop guards. Returns false if the close order fails.
    const flatten = async (reason) => {
      const closeSide = position.side === "long" ? "sell" : "buy";
      console.log(`  PROP FLATTEN (${reason}) — closing ${position.side.toUpperCase()} ${position.quantity} at ~$${price.toFixed(2)}`);
      let order;
      try {
        order = await executeOrder(closeSide, position.quantity);
      } catch (err) {
        console.log(`  ❌ PROP FLATTEN FAILED — ${err.message} (will retry next run)`);
        log.trades.push({ timestamp: new Date().toISOString(), type: "exit", symbol: CONFIG.symbol, side: closeSide, orderPlaced: false, error: err.message, reason: `prop: ${reason}`, paperTrading: CONFIG.paperTrading });
        saveLog(log);
        return false;
      }
      const pnl = position.side === "long"
        ? (price - position.entryPrice) * position.quantity
        : (position.entryPrice - price) * position.quantity;
      portfolioValue += pnl;
      paperFee(price * position.quantity);
      savePortfolio(portfolioValue);
      log.trades.push({ timestamp: new Date().toISOString(), type: "exit", symbol: CONFIG.symbol, side: closeSide, quantity: position.quantity, price, sizeUSD: position.sizeUSD, pnlUSD: pnl, reason: `prop: ${reason}`, orderPlaced: true, orderId: order.orderId, paperTrading: CONFIG.paperTrading });
      saveLog(log);
      writeCsvRow({ side: closeSide.toUpperCase(), quantity: position.quantity, price, totalUSD: position.sizeUSD, orderId: order.orderId, mode: CONFIG.paperTrading ? "PAPER" : "LIVE", notes: `PROP ${reason} — P&L $${pnl.toFixed(2)} | Portfolio: $${portfolioValue.toFixed(2)}` });
      savePosition(null);
      position = null;
      equity = portfolioValue;
      return true;
    };

    console.log(`\n── PROP MODE ────────────────────────────────────────────\n`);
    console.log(`  Status: ${prop.status} | Equity: $${equity.toFixed(2)} | Target: $${targetAbs.toFixed(2)} | Guard floor: $${guardFloor.toFixed(2)} (firm floor $${firmFloor.toFixed(2)})`);

    if (prop.status !== "active") {
      savePropState(prop);
      console.log(`  Challenge status "${prop.status}" — trading stopped. Board action required.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // Target lock: flatten to convert floating gain to closed balance (firms measure target on balance)
    if (equity >= targetAbs) {
      if (position && !(await flatten("target lock"))) { savePropState(prop); return; }
      if (portfolioValue >= targetAbs) {
        prop.status = "passed";
        savePropState(prop);
        console.log(`  🎉 TARGET REACHED — closed balance $${portfolioValue.toFixed(2)} ≥ $${targetAbs.toFixed(2)}. Trading stopped.`);
        console.log("═══════════════════════════════════════════════════════════\n");
        return;
      }
    }

    // Max-DD guard: halt before the firm's floor is breached
    if (equity <= guardFloor) {
      if (position && !(await flatten("max-DD guard"))) { savePropState(prop); return; }
      prop.status = "halted-dd";
      savePropState(prop);
      console.log(`  🛑 MAX-DD GUARD — equity $${equity.toFixed(2)} ≤ guard floor $${guardFloor.toFixed(2)}. Trading halted BEFORE firm breach. Board review required.`);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // Daily circuit breaker (only for firms with a daily loss rule)
    if (CONFIG.propDailyLimitPct > 0) {
      const dayLoss = prop.dayStartEquity - equity;
      const guardAt = initial * (CONFIG.propDailyLimitPct / 100) * CONFIG.propDailyGuard;
      if (!prop.dayHalted && dayLoss >= guardAt) {
        if (position && !(await flatten("daily circuit breaker"))) { savePropState(prop); return; }
        prop.dayHalted = true;
        savePropState(prop);
        console.log(`  🛑 DAILY BREAKER — day loss $${dayLoss.toFixed(2)} ≥ $${guardAt.toFixed(2)}. Flat until next UTC day.`);
        console.log("═══════════════════════════════════════════════════════════\n");
        return;
      }
      if (prop.dayHalted) {
        savePropState(prop);
        console.log(`  Day halted by circuit breaker — no trading until next UTC day.`);
        console.log("═══════════════════════════════════════════════════════════\n");
        return;
      }
    }
    savePropState(prop);
  }

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

    // Trailing stop — ratchet 3×ATR each run to lock in profits
    const TRAIL_MULT = 3.0;
    if (atr) {
      const trailDist = atr * TRAIL_MULT;
      if (position.side === "long") {
        const newStop = price - trailDist;
        if (newStop > (position.stopLossPrice ?? 0)) {
          console.log(`  Trailing stop ratcheted: $${(position.stopLossPrice ?? 0).toFixed(2)} → $${newStop.toFixed(2)}`);
          position.stopLossPrice = newStop;
        }
      } else {
        const newStop = price + trailDist;
        if (position.stopLossPrice == null || newStop < position.stopLossPrice) {
          console.log(`  Trailing stop ratcheted: $${(position.stopLossPrice ?? Infinity).toFixed(2)} → $${newStop.toFixed(2)}`);
          position.stopLossPrice = newStop;
        }
      }
    }
    console.log(`  Stop loss: $${position.stopLossPrice != null ? position.stopLossPrice.toFixed(2) : "N/A"}`);

    // Paper-mode stop hit check (live trades: BitGet enforces the preset stop)
    if (CONFIG.paperTrading && position.stopLossPrice != null) {
      const stopHit = position.side === "long"
        ? price <= position.stopLossPrice
        : price >= position.stopLossPrice;
      if (stopHit) {
        const stoppedSide = position.side;
        const stopPnl = position.side === "long"
          ? (position.stopLossPrice - position.entryPrice) * position.quantity
          : (position.entryPrice - position.stopLossPrice) * position.quantity;
        portfolioValue += stopPnl;
        paperFee(position.stopLossPrice * position.quantity);
        savePortfolio(portfolioValue);
        console.log(`  ⛔ STOP HIT at $${position.stopLossPrice.toFixed(2)} — P&L $${stopPnl.toFixed(2)} | Portfolio: $${portfolioValue.toFixed(2)}`);
        log.trades.push({ timestamp: new Date().toISOString(), type: "stop", symbol: CONFIG.symbol, side: position.side, price: position.stopLossPrice, pnlUSD: stopPnl, reason: "trailing stop hit", paperTrading: true });
        saveLog(log);
        writeCsvRow({ side: (position.side === "long" ? "sell" : "buy").toUpperCase(), quantity: position.quantity, price: position.stopLossPrice, totalUSD: position.sizeUSD, orderId: "PAPER-STOP", mode: "PAPER", notes: `Trailing stop hit — P&L $${stopPnl.toFixed(2)} (${((stopPnl / position.sizeUSD) * 100).toFixed(2)}%) | Portfolio: $${portfolioValue.toFixed(2)}` });
        savePosition(null);
        position = null;

        // Re-entry: if ADX still strong, immediately re-enter same direction at half size
        // (disabled in prop mode — the validated challenge sim has no re-entries)
        if (adxStrong && !CONFIG.propMode) {
          const reOrderSide = stoppedSide === "long" ? "buy" : "sell";
          const mtfOk = stoppedSide === "long" ? mtfOkLong : mtfOkShort;
          if (mtfOk && !regimeAllows) {
            console.log(`  🚦 REGIME GATE — re-entry blocked (${regimeNote})`);
            log.gateBlocks = log.gateBlocks || [];
            log.gateBlocks.push({ timestamp: new Date().toISOString(), signal: `re-entry ${stoppedSide}`, note: regimeNote });
            saveLog(log);
          } else if (mtfOk) {
            console.log(`  ♻️  ADX ${adxValue.toFixed(1)} still strong — re-entering ${stoppedSide.toUpperCase()} at full size`);
            await openPosition(reOrderSide, stoppedSide, "Re-entry after stop (ADX strong)", 1.0);
          } else {
            console.log(`  ADX ${adxValue.toFixed(1)} strong but 4H trend flipped — skipping re-entry`);
          }
        }

        console.log("═══════════════════════════════════════════════════════════\n");
        return;
      }
    }

    // Pyramid — add to position when winning and trend is strong
    const PYRAMID_THRESHOLD = 0.10; // add every 10% of unrealised profit
    const MAX_PYRAMIDS      = 3;
    const alreadyPyramided  = position.pyramided ?? 0;
    const unrealisedPct = position.side === "long"
      ? (price - position.entryPrice) / position.entryPrice
      : (position.entryPrice - price) / position.entryPrice;
    const nextThreshold = PYRAMID_THRESHOLD * (alreadyPyramided + 1);

    if (alreadyPyramided < MAX_PYRAMIDS && unrealisedPct >= nextThreshold && adxStrong && atr && !CONFIG.propMode) {
      // Pyramid add: risk half the normal riskPct on each add, capped at 50% portfolio notional
      const addRisk    = portfolioValue * CONFIG.riskPct * 0.5;
      const addQty     = Math.min(addRisk / (atr * NKB.atrStopMult), (portfolioValue * 0.5) / price);
      const addSizeUSD = addQty * price;
      const addSide    = position.side === "long" ? "buy" : "sell";
      console.log(`\n📈 PYRAMID #${alreadyPyramided + 1} — unrealised ${(unrealisedPct * 100).toFixed(1)}% ≥ ${(nextThreshold * 100).toFixed(0)}%, ADX ${adxValue.toFixed(1)} — adding $${addSizeUSD.toFixed(2)}`);

      let addOrder;
      try {
        addOrder = await executeOrder(addSide, addQty.toFixed(6));
      } catch (err) {
        console.log(`❌ PYRAMID ORDER FAILED — ${err.message}`);
        addOrder = null;
      }

      if (addOrder) {
        const totalQty = position.quantity + addQty;
        position.entryPrice = (position.entryPrice * position.quantity + price * addQty) / totalQty;
        position.quantity   = totalQty;
        position.sizeUSD    = (position.sizeUSD ?? 0) + addSizeUSD;
        position.pyramided  = alreadyPyramided + 1;
        console.log(`  Blended entry: $${position.entryPrice.toFixed(2)} | Total qty: ${position.quantity.toFixed(6)} | Pyramids: ${position.pyramided}`);
        log.trades.push({ timestamp: new Date().toISOString(), type: "pyramid", symbol: CONFIG.symbol, side: addSide, quantity: addQty, price, sizeUSD: addSizeUSD, pyramidNum: position.pyramided, orderId: addOrder.orderId, paperTrading: CONFIG.paperTrading });
        saveLog(log);
        paperFee(addSizeUSD);
        savePortfolio(portfolioValue);
        writeCsvRow({ side: addSide.toUpperCase(), quantity: addQty, price, totalUSD: addSizeUSD, orderId: addOrder.orderId, mode: CONFIG.paperTrading ? "PAPER" : "LIVE", notes: `Pyramid #${position.pyramided} add | Portfolio: $${portfolioValue.toFixed(2)}` });
      }
    }

    // ADX hold: if trend is still strong (ADX > 25), ignore the NKB flip and stay in
    if (crossExit && adxStrong) {
      console.log(`  NKB flip detected BUT ADX ${adxValue.toFixed(1)} > 25 — trend still strong, holding`);
      savePosition(position);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    if (crossExit) {
      const closeSide = position.side === "long" ? "sell" : "buy";
      console.log(`  NKB reversal signal — closing position (ADX ${adxValue != null ? adxValue.toFixed(1) : "N/A"} ≤ 25, trend weak)`);
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
      paperFee(price * position.quantity);
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

  async function openPosition(side, positionSide, signalNote, sizeMult = 1.0) {
    // Fixed % risk sizing: risk riskPct of portfolio on this trade
    // Position size = riskAmount / stopDist — so a stop hit loses exactly riskPct
    const stopDist = atrStopDist ?? (price * (CONFIG.stopLossPct / 100));
    // Prop mode risks a fixed % of the INITIAL balance (predictable daily-loss math);
    // normal mode risks % of current portfolio.
    const riskBase = CONFIG.propMode && prop
      ? prop.initialBalance * (CONFIG.propRiskPct / 100)
      : portfolioValue * CONFIG.riskPct;
    const riskAmount = riskBase * sizeMult;
    const riskBasedQty = stopDist > 0 ? riskAmount / stopDist : 0;
    // Notional cap: prop mode uses the firm's leverage cap; normal mode 1x portfolio
    const maxQty = CONFIG.propMode
      ? (portfolioValue * CONFIG.propLevCap) / price
      : portfolioValue / price;
    const quantity = parseFloat(Math.min(riskBasedQty, maxQty).toFixed(6));
    const tradeSize = quantity * price;
    const stopLossPrice = positionSide === "long" ? price - stopDist : price + stopDist;
    console.log(`✅ ${side.toUpperCase()} SIGNAL — ${signalNote}`);
    console.log(`   Risk: $${riskAmount.toFixed(2)} (${(CONFIG.riskPct * 100).toFixed(0)}% of $${portfolioValue.toFixed(2)}) | Stop dist: $${stopDist.toFixed(2)} | Size: $${tradeSize.toFixed(2)}`);
    console.log(`   Stop loss: $${stopLossPrice.toFixed(2)} (ATR×${NKB.atrStopMult})`);
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

    savePosition({ side: positionSide, entryPrice: price, quantity, sizeUSD: tradeSize, stopLossPrice, openedAt: new Date().toISOString(), orderId: order.orderId, pyramided: 0 });
    paperFee(tradeSize);
    savePortfolio(portfolioValue);
    log.trades.push({ timestamp: new Date().toISOString(), type: "entry", symbol: CONFIG.symbol, side, quantity, price, sizeUSD: tradeSize, portfolioValue, nkb, orderPlaced: true, orderId: order.orderId, paperTrading: CONFIG.paperTrading });
    saveLog(log);
    writeCsvRow({ side: side.toUpperCase(), quantity, price, totalUSD: tradeSize, orderId: order.orderId, mode: CONFIG.paperTrading ? "PAPER" : "LIVE", notes: `NKB ${signalNote} | Portfolio: $${portfolioValue.toFixed(2)}` });
    console.log(`✅ ${positionSide} opened — exits on next NKB reversal signal only`);
  }

  if ((buySignal || sellSignal) && !regimeAllows) {
    console.log(`🚦 REGIME GATE (${CONFIG.regimeGate}) — ${buySignal ? "BUY" : "SELL"} signal blocked (${regimeNote})`);
    log.gateBlocks = log.gateBlocks || [];
    log.gateBlocks.push({ timestamp: new Date().toISOString(), signal: buySignal ? "BUY" : "SELL", note: regimeNote });
    saveLog(log);
  } else if (buySignal) {
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
