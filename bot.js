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
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "0.3"),
  trailingStopPct: parseFloat(process.env.TRAILING_STOP_PCT || "0.5"),
  atrPeriod: parseInt(process.env.ATR_PERIOD || "14"),
  atrStopMult: parseFloat(process.env.ATR_STOP_MULT || "1.5"),
  atrTrailingMult: parseFloat(process.env.ATR_TRAILING_MULT || "2.5"),
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

export const LOG_FILE = "safety-check-log.json";
export const POSITION_FILE = "position.json";

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

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ATR — average true range, measures recent volatility in price terms
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    trueRanges.push(
      Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close),
      ),
    );
  }
  const recent = trueRanges.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check (entries) ─────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine bias first
  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;
  let bias = "neutral";

  if (bullishBias) {
    bias = "bullish";
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );

    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );

    check(
      "RSI(3) below 30 (snap-back setup in uptrend)",
      "< 30",
      rsi3.toFixed(2),
      rsi3 < 30,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    bias = "bearish";
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );

    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );

    check(
      "RSI(3) above 70 (reversal setup in downtrend)",
      "> 70",
      rsi3.toFixed(2),
      rsi3 > 70,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass, bias };
}

// ─── Exit Check (open positions: trailing stop + fixed stop loss) ──────────

function checkExitConditions(position, price, atr) {
  console.log("\n── Position Management ──────────────────────────────────\n");
  console.log(`  Side: ${position.side.toUpperCase()} | Entry: $${position.entryPrice.toFixed(2)} | Current: $${price.toFixed(2)}`);

  // Volatility-adjusted distances: the wider of "fixed %" and "ATR × multiplier"
  // wins, so calm markets keep the tight fixed % stop, and choppy markets get
  // more room instead of being stopped out by normal noise.
  const atrStopDist = atr ? atr * CONFIG.atrStopMult : null;
  const atrTrailingDist = atr ? atr * CONFIG.atrTrailingMult : null;
  const fixedStopDist = position.entryPrice * (CONFIG.stopLossPct / 100);

  const stopLossDist = atrStopDist ? Math.max(atrStopDist, fixedStopDist) : fixedStopDist;

  let stopPrice;
  let trailingStopPrice;
  let stopLossPrice;

  if (position.side === "long") {
    if (price > position.extremePrice) position.extremePrice = price;
    const fixedTrailingDist = position.extremePrice * (CONFIG.trailingStopPct / 100);
    const trailingDist = atrTrailingDist ? Math.max(atrTrailingDist, fixedTrailingDist) : fixedTrailingDist;
    trailingStopPrice = position.extremePrice - trailingDist;
    stopLossPrice = position.entryPrice - stopLossDist;
    // Trailing stop only takes over once it has ratcheted above the fixed stop loss
    stopPrice = Math.max(trailingStopPrice, stopLossPrice);
    var shouldExit = price <= stopPrice;
  } else {
    if (price < position.extremePrice) position.extremePrice = price;
    const fixedTrailingDist = position.extremePrice * (CONFIG.trailingStopPct / 100);
    const trailingDist = atrTrailingDist ? Math.max(atrTrailingDist, fixedTrailingDist) : fixedTrailingDist;
    trailingStopPrice = position.extremePrice + trailingDist;
    stopLossPrice = position.entryPrice + stopLossDist;
    stopPrice = Math.min(trailingStopPrice, stopLossPrice);
    var shouldExit = price >= stopPrice;
  }

  const pnlUSD =
    position.side === "long"
      ? (price - position.entryPrice) * position.quantity
      : (position.entryPrice - price) * position.quantity;
  const pnlPct = (pnlUSD / position.sizeUSD) * 100;

  console.log(`  ATR(${CONFIG.atrPeriod}): ${atr ? "$" + atr.toFixed(2) : "N/A — using fixed % only"}`);
  console.log(`  Stop loss:     $${stopLossPrice.toFixed(2)} (${atrStopDist && atrStopDist > fixedStopDist ? "ATR-widened" : "fixed"}, $${stopLossDist.toFixed(2)} from entry)`);
  console.log(`  Trailing stop: $${trailingStopPrice.toFixed(2)} (${atrTrailingDist && atrTrailingDist > position.entryPrice * (CONFIG.trailingStopPct / 100) ? "ATR-widened" : "fixed"}, from best price $${position.extremePrice.toFixed(2)})`);
  console.log(`  Unrealized P&L: $${pnlUSD.toFixed(2)} (${pnlPct.toFixed(2)}%)`);

  if (shouldExit) {
    const reason = position.side === "long"
      ? (price <= trailingStopPrice && trailingStopPrice > stopLossPrice ? "Trailing stop hit" : "Stop loss hit")
      : (price >= trailingStopPrice && trailingStopPrice < stopLossPrice ? "Trailing stop hit" : "Stop loss hit");
    console.log(`  🚫 ${reason} — closing position`);
    return { shouldExit: true, reason, pnlUSD, pnlPct };
  }

  console.log("  ✅ Within stop levels — holding position");
  return { shouldExit: false, pnlUSD, pnlPct };
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

async function placeBitGetOrder(symbol, side, quantity) {
  const qty = parseFloat(quantity).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity: qty,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
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
// opening and closing positions — `side` is "buy" or "sell".
async function executeOrder(side, quantity) {
  if (CONFIG.paperTrading) {
    return { orderId: `PAPER-${Date.now()}`, paper: true };
  }
  const order = await placeBitGetOrder(CONFIG.symbol, side, quantity);
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

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Fetch candle data — need enough for EMA(8) + full session for VWAP
  console.log("\n── Fetching market data from BitGet ─────────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  const ema8 = calcEMA(closes, 8);
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);
  const atr = calcATR(candles, CONFIG.atrPeriod);

  console.log(`  EMA(8):  $${ema8.toFixed(2)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);
  console.log(`  ATR(${CONFIG.atrPeriod}): ${atr ? "$" + atr.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  const log = loadLog();
  let position = loadPosition();

  // ── Manage an existing open position first — exits always take priority ──
  if (position) {
    const exit = checkExitConditions(position, price, atr);

    if (exit.shouldExit) {
      const closeSide = position.side === "long" ? "sell" : "buy";
      console.log(
        `\n${CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE"} CLOSE — ${closeSide.toUpperCase()} ${position.quantity} ${CONFIG.symbol} at ~$${price.toFixed(2)}`,
      );

      let order;
      try {
        order = await executeOrder(closeSide, position.quantity);
      } catch (err) {
        console.log(`❌ CLOSE FAILED — ${err.message}`);
        log.trades.push({
          timestamp: new Date().toISOString(),
          type: "exit",
          symbol: CONFIG.symbol,
          side: closeSide,
          orderPlaced: false,
          error: err.message,
          paperTrading: CONFIG.paperTrading,
        });
        saveLog(log);
        return;
      }

      log.trades.push({
        timestamp: new Date().toISOString(),
        type: "exit",
        symbol: CONFIG.symbol,
        side: closeSide,
        quantity: position.quantity,
        price,
        sizeUSD: position.sizeUSD,
        pnlUSD: exit.pnlUSD,
        pnlPct: exit.pnlPct,
        reason: exit.reason,
        orderPlaced: true,
        orderId: order.orderId,
        paperTrading: CONFIG.paperTrading,
      });
      saveLog(log);

      writeCsvRow({
        side: closeSide.toUpperCase(),
        quantity: position.quantity,
        price,
        totalUSD: position.sizeUSD,
        orderId: order.orderId,
        mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
        notes: `Exit (${exit.reason}) — P&L $${exit.pnlUSD.toFixed(2)} (${exit.pnlPct.toFixed(2)}%)`,
      });

      savePosition(null);
      console.log(`\n✅ Position closed — ${exit.reason}`);
    } else {
      savePosition(position);
      console.log("\nHolding position — no new entries while a position is open.");
    }

    console.log("═══════════════════════════════════════════════════════════\n");
    return;
  }

  // ── No open position — look for a new entry ──
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    console.log("═══════════════════════════════════════════════════════════\n");
    return;
  }

  const { results, allPass, bias } = runSafetyCheck(price, ema8, vwap, rsi3, rules);
  const tradeSize = Math.min(CONFIG.portfolioValue * 0.01, CONFIG.maxTradeSizeUSD);

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const canShort = CONFIG.tradeMode === "futures";
  const blockedShort = allPass && bias === "bearish" && !canShort;

  if (!allPass || blockedShort) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    if (blockedShort) {
      console.log("🚫 TRADE BLOCKED — bearish setup confirmed, but spot mode can't open short positions.");
      console.log("   Set TRADE_MODE=futures in .env to enable shorting.");
    } else {
      console.log(`🚫 TRADE BLOCKED`);
      console.log(`   Failed conditions:`);
      failed.forEach((f) => console.log(`   - ${f}`));
    }

    log.trades.push({
      timestamp: new Date().toISOString(),
      type: "entry",
      symbol: CONFIG.symbol,
      price,
      indicators: { ema8, vwap, rsi3 },
      conditions: results,
      bias,
      allPass: false,
      orderPlaced: false,
      paperTrading: CONFIG.paperTrading,
    });
    saveLog(log);

    writeCsvRow({
      price,
      orderId: "BLOCKED",
      mode: "BLOCKED",
      notes: blockedShort
        ? "Bearish signal — shorting unavailable in spot mode"
        : `Failed: ${failed.join("; ")}`,
    });
  } else {
    console.log(`✅ ALL CONDITIONS MET — ${bias.toUpperCase()} setup`);

    const side = bias === "bullish" ? "buy" : "sell";
    const positionSide = bias === "bullish" ? "long" : "short";
    const quantity = parseFloat((tradeSize / price).toFixed(6));

    console.log(
      `\n${CONFIG.paperTrading ? "📋 PAPER TRADE" : "🔴 PLACING LIVE ORDER"} — ${side.toUpperCase()} ~$${tradeSize.toFixed(2)} ${CONFIG.symbol} (opening ${positionSide})`,
    );
    if (CONFIG.paperTrading) {
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
    }

    let order;
    let orderFailed = false;
    try {
      order = await executeOrder(side, quantity);
    } catch (err) {
      console.log(`❌ ORDER FAILED — ${err.message}`);
      orderFailed = true;
      log.trades.push({
        timestamp: new Date().toISOString(),
        type: "entry",
        symbol: CONFIG.symbol,
        price,
        bias,
        allPass: true,
        orderPlaced: false,
        error: err.message,
        paperTrading: CONFIG.paperTrading,
      });
      saveLog(log);
      writeCsvRow({
        price,
        orderId: "FAILED",
        mode: "BLOCKED",
        notes: `Order failed: ${err.message}`,
      });
    }

    if (!orderFailed) {
      const newPosition = {
        side: positionSide,
        entryPrice: price,
        quantity,
        sizeUSD: tradeSize,
        extremePrice: price,
        openedAt: new Date().toISOString(),
        orderId: order.orderId,
      };
      savePosition(newPosition);

      log.trades.push({
        timestamp: new Date().toISOString(),
        type: "entry",
        symbol: CONFIG.symbol,
        side,
        quantity,
        price,
        sizeUSD: tradeSize,
        indicators: { ema8, vwap, rsi3 },
        conditions: results,
        bias,
        allPass: true,
        orderPlaced: true,
        orderId: order.orderId,
        paperTrading: CONFIG.paperTrading,
      });
      saveLog(log);

      writeCsvRow({
        side: side.toUpperCase(),
        quantity,
        price,
        totalUSD: tradeSize,
        orderId: order.orderId,
        mode: CONFIG.paperTrading ? "PAPER" : "LIVE",
        notes: `Opened ${positionSide} — all conditions met`,
      });

      console.log(`✅ Position opened — ${positionSide}, stop loss ${CONFIG.stopLossPct}%, trailing stop ${CONFIG.trailingStopPct}%`);
    }
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
