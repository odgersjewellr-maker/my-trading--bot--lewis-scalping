/**
 * Order-flow exit watcher — Binance mainnet aggTrade stream.
 *
 * WHY THIS EXISTS
 * ───────────────
 * bot.js is a run-once cron job whose entries and exits come from CANDLES
 * (EMA/VWAP/RSI). A candle has already discarded order flow — it cannot tell
 * you whether the bar's volume was aggressive buyers lifting the offer or
 * aggressive sellers hitting the bid. That information only lives in the
 * trade-by-trade tape.
 *
 * This is a SEPARATE long-running process that:
 *   1. subscribes to Binance's PUBLIC aggTrade websocket (no API key, no risk —
 *      read-only market data on mainnet, so the signal is REAL order flow);
 *   2. maintains a rolling order-flow imbalance (OFI) meter;
 *   3. watches the bot's own position file (position-<KEY>.json);
 *   4. when flow turns decisively AGAINST an open position, raises an early-exit
 *      signal — earlier than the bot's lagging RSI(3)-crosses-50 exit.
 *
 * It is deliberately ADVISORY / non-destructive by default: it logs the
 * simulated close and writes a signal file, but does NOT mutate the bot's
 * position state unless you pass --apply. This keeps it safe to run alongside
 * the live cron bot without racing it for the position file.
 *
 * Data source: wss://stream.binance.com:9443/ws/<symbol>@aggTrade
 * aggTrade payload field `m` = "is the buyer the market maker?"
 *   m === true  → buyer is maker  → the AGGRESSOR is the SELLER → sell-side flow
 *   m === false → buyer is taker  → the AGGRESSOR is the BUYER  → buy-side flow
 *
 * USAGE
 *   node flow-exit-watcher.js                 # live, symbol from SYMBOL env or BTCUSDT
 *   node flow-exit-watcher.js --symbol ETHUSDT
 *   node flow-exit-watcher.js --selftest      # offline deterministic logic test
 *   node flow-exit-watcher.js --replay tape.jsonl   # replay recorded trades
 *   node flow-exit-watcher.js --record tape.jsonl   # save live trades for replay
 *   node flow-exit-watcher.js --apply         # actually flatten position (paper state)
 *
 * ENV (all optional — defaults are conservative)
 *   SYMBOL                    trading pair (default BTCUSDT)
 *   INSTANCE_ID               overrides the position-file key (matches bot.js)
 *   FLOW_WINDOW_MS            rolling OFI window in ms          (default 5000)
 *   FLOW_IMBALANCE_THRESHOLD  |imbalance| against you to trip   (default 0.45)
 *   FLOW_MIN_NOTIONAL_USD     min traded $ in window to act on  (default 50000)
 *   FLOW_CONFIRM_TICKS        consecutive adverse checks needed (default 3)
 *   FLOW_CHECK_INTERVAL_MS    how often to evaluate             (default 1000)
 *   PAPER_FEE_RATE            fee+slippage per side for sim P&L (default 0.0008)
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";

// ─── Config ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function flag(name) { return argv.includes(`--${name}`); }
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

export const CFG = {
  symbol:        (opt("symbol", process.env.SYMBOL) || "BTCUSDT").toUpperCase(),
  windowMs:      parseInt(process.env.FLOW_WINDOW_MS || "5000", 10),
  threshold:     parseFloat(process.env.FLOW_IMBALANCE_THRESHOLD || "0.45"),
  minNotional:   parseFloat(process.env.FLOW_MIN_NOTIONAL_USD || "50000"),
  confirmTicks:  parseInt(process.env.FLOW_CONFIRM_TICKS || "3", 10),
  checkEveryMs:  parseInt(process.env.FLOW_CHECK_INTERVAL_MS || "1000", 10),
  feeRate:       parseFloat(process.env.PAPER_FEE_RATE || "0.0008"),
};

const FILE_KEY = process.env.INSTANCE_ID || CFG.symbol;
export const POSITION_FILE  = `position-${FILE_KEY}.json`;
export const FLOW_LOG_FILE   = `flow-exit-log-${FILE_KEY}.json`;
export const FLOW_SIGNAL_FILE = `flow-exit-signal-${FILE_KEY}.json`;

// ─── Pure signal core (exported for tests — no I/O, no network) ──────────────

/** Convert a raw Binance aggTrade message into a signed-volume tick. */
export function classifyTrade(msg) {
  const price = parseFloat(msg.p);
  const qty   = parseFloat(msg.q);
  const isBuyerMaker = msg.m === true;
  // aggressor = seller when the buyer is the maker
  const side = isBuyerMaker ? "sell" : "buy";
  return {
    ts: msg.T ?? Date.now(),
    price,
    qty,
    side,
    signedQty: (isBuyerMaker ? -1 : 1) * qty,   // + = aggressive buy, − = aggressive sell
    notional: price * qty,
  };
}

/**
 * Rolling order-flow meter. Keeps ticks inside a time window and reports the
 * buy/sell split and a normalised imbalance in [−1, +1]:
 *   +1 = every aggressor was a buyer, −1 = every aggressor was a seller.
 */
export class OrderFlowMeter {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.ticks = [];
    this.lastPrice = null;
  }

  ingest(tick) {
    this.ticks.push(tick);
    this.lastPrice = tick.price;
  }

  _prune(now) {
    const cutoff = now - this.windowMs;
    // ticks are appended in time order; drop from the front
    let i = 0;
    while (i < this.ticks.length && this.ticks[i].ts < cutoff) i++;
    if (i > 0) this.ticks.splice(0, i);
  }

  snapshot(now = Date.now()) {
    this._prune(now);
    let buyQty = 0, sellQty = 0, buyNotional = 0, sellNotional = 0;
    for (const t of this.ticks) {
      if (t.signedQty >= 0) { buyQty += t.qty; buyNotional += t.notional; }
      else { sellQty += t.qty; sellNotional += t.notional; }
    }
    const totalQty = buyQty + sellQty;
    const totalNotional = buyNotional + sellNotional;
    const imbalance = totalQty > 0 ? (buyQty - sellQty) / totalQty : 0;
    return {
      imbalance,            // [−1,+1]; sign = which side is the aggressor
      buyQty, sellQty, totalQty,
      buyNotional, sellNotional, totalNotional,
      lastPrice: this.lastPrice,
      trades: this.ticks.length,
    };
  }
}

/**
 * Decide whether flow has turned against an open position.
 * Pure: takes a position object (or null) and a meter snapshot.
 */
export function evaluateExit(position, snap, cfg = CFG) {
  if (!position || !position.side) {
    return { exit: false, reason: "no open position", pressure: 0 };
  }
  // pressureAgainst > 0 means the aggressor side is working against us.
  //  - long is hurt by SELL pressure (negative imbalance) → −imbalance
  //  - short is hurt by BUY pressure (positive imbalance) → +imbalance
  const pressure = position.side === "long" ? -snap.imbalance : snap.imbalance;

  if (snap.totalNotional < cfg.minNotional) {
    return { exit: false, reason: `thin tape ($${snap.totalNotional.toFixed(0)} < $${cfg.minNotional})`, pressure };
  }
  if (pressure >= cfg.threshold) {
    return {
      exit: true,
      reason: `flow against ${position.side}: pressure ${pressure.toFixed(2)} ≥ ${cfg.threshold} on $${snap.totalNotional.toFixed(0)} tape`,
      pressure,
    };
  }
  return { exit: false, reason: `pressure ${pressure.toFixed(2)} < ${cfg.threshold}`, pressure };
}

/** Simulated close P&L at a given price (paper — mirrors bot.js paper accounting). */
export function simulateClose(position, price, feeRate = CFG.feeRate) {
  const gross = position.side === "long"
    ? (price - position.entryPrice) * position.quantity
    : (position.entryPrice - price) * position.quantity;
  const fee = price * position.quantity * feeRate;
  return { gross, fee, net: gross - fee, exitPrice: price };
}

// ─── I/O helpers ────────────────────────────────────────────────────────────

function loadPosition() {
  if (!existsSync(POSITION_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(POSITION_FILE, "utf8"));
    return raw === null ? null : raw;
  } catch { return null; }
}

function appendFlowLog(entry) {
  let log = { events: [] };
  if (existsSync(FLOW_LOG_FILE)) {
    try { log = JSON.parse(readFileSync(FLOW_LOG_FILE, "utf8")); } catch { /* start fresh */ }
  }
  if (!Array.isArray(log.events)) log.events = [];
  log.events.push(entry);
  writeFileSync(FLOW_LOG_FILE, JSON.stringify(log, null, 2));
}

function fmtPressureBar(pressure) {
  const mag = Math.min(1, Math.abs(pressure));
  const filled = Math.round(mag * 10);
  return (pressure >= 0 ? "▓" : "░").repeat(filled).padEnd(10, "·");
}

// ─── Runtime: live websocket loop ───────────────────────────────────────────

function handleExit(position, snap, decision, { apply }) {
  const price = snap.lastPrice ?? position.entryPrice;
  const pnl = simulateClose(position, price);
  const event = {
    timestamp: new Date().toISOString(),
    symbol: CFG.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice: price,
    quantity: position.quantity,
    pnlGrossUSD: +pnl.gross.toFixed(4),
    feeUSD: +pnl.fee.toFixed(4),
    pnlNetUSD: +pnl.net.toFixed(4),
    imbalance: +snap.imbalance.toFixed(3),
    pressure: +decision.pressure.toFixed(3),
    tapeNotionalUSD: +snap.totalNotional.toFixed(0),
    reason: decision.reason,
    applied: !!apply,
    mode: apply ? "APPLIED (paper position flattened)" : "ADVISORY (logged only)",
  };
  appendFlowLog(event);
  writeFileSync(FLOW_SIGNAL_FILE, JSON.stringify(event, null, 2));

  console.log("\n🚨 ORDER-FLOW EXIT SIGNAL");
  console.log(`   ${position.side.toUpperCase()} ${CFG.symbol} @ entry ${position.entryPrice} → mark ${price}`);
  console.log(`   ${decision.reason}`);
  console.log(`   Simulated P&L: gross $${pnl.gross.toFixed(2)}  fee $${pnl.fee.toFixed(2)}  net $${pnl.net.toFixed(2)}`);
  console.log(`   ${event.mode}  → ${FLOW_SIGNAL_FILE}`);

  if (apply) {
    // Non-default: flatten the paper position so the cron bot sees a flat book.
    writeFileSync(POSITION_FILE, JSON.stringify(null));
    console.log(`   ⚠️  position-${FILE_KEY}.json set to null (paper flat).`);
  }
}

async function runLive({ apply, record }) {
  const stream = `wss://stream.binance.com:9443/ws/${CFG.symbol.toLowerCase()}@aggTrade`;
  const meter = new OrderFlowMeter(CFG.windowMs);
  let consecutive = 0;
  let firedForThisPosition = null;   // openedAt of the position we already fired on
  let backoff = 1000;

  console.log(`▶  Order-flow exit watcher — ${CFG.symbol}`);
  console.log(`   window ${CFG.windowMs}ms · threshold ${CFG.threshold} · confirm ${CFG.confirmTicks} · min $${CFG.minNotional}`);
  console.log(`   position file: ${POSITION_FILE}  ·  mode: ${apply ? "APPLY" : "ADVISORY"}`);
  console.log(`   stream: ${stream}\n`);

  const check = () => {
    const now = Date.now();
    const snap = meter.snapshot(now);
    const position = loadPosition();

    // reset the fire-latch when the position changes/closes
    if (!position) { consecutive = 0; firedForThisPosition = null; }
    else if (position.openedAt !== firedForThisPosition) {
      // new position since our last fire — allow firing again
      if (firedForThisPosition && position.openedAt !== firedForThisPosition) firedForThisPosition = null;
    }

    const decision = evaluateExit(position, snap, CFG);
    consecutive = decision.exit ? consecutive + 1 : 0;

    // status line (throttled to the check interval)
    if (position) {
      const bar = fmtPressureBar(decision.pressure);
      process.stdout.write(
        `\r${new Date(now).toISOString().slice(11, 19)} ${position.side.padEnd(5)} ` +
        `imb ${snap.imbalance >= 0 ? "+" : ""}${snap.imbalance.toFixed(2)} ` +
        `press ${bar} ${decision.pressure.toFixed(2)} ` +
        `$${(snap.totalNotional / 1000).toFixed(0)}k ${snap.trades}t ${consecutive}/${CFG.confirmTicks}   `
      );
    } else {
      process.stdout.write(`\r${new Date(now).toISOString().slice(11, 19)} flat — waiting for a position…   `);
    }

    if (position && decision.exit && consecutive >= CFG.confirmTicks && position.openedAt !== firedForThisPosition) {
      firedForThisPosition = position.openedAt;
      consecutive = 0;
      handleExit(position, snap, decision, { apply });
    }
  };

  const connect = () => {
    const ws = new WebSocket(stream);
    ws.addEventListener("open", () => { backoff = 1000; console.log("🔌 connected\n"); });
    ws.addEventListener("message", (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || msg.e !== "aggTrade") return;
      if (record) appendFileSync(record, JSON.stringify(msg) + "\n");
      meter.ingest(classifyTrade(msg));
    });
    ws.addEventListener("close", () => {
      console.log(`\n🔌 disconnected — reconnecting in ${backoff}ms`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    });
    ws.addEventListener("error", (e) => {
      console.log(`\n⚠️  socket error: ${e?.message || e?.type || "unknown"}`);
      try { ws.close(); } catch { /* noop */ }
    });
  };

  connect();
  setInterval(check, CFG.checkEveryMs);
}

// ─── Replay: feed a recorded JSONL tape through the exact same logic ─────────

async function runReplay(file, { apply }) {
  if (!existsSync(file)) { console.error(`replay file not found: ${file}`); process.exit(1); }
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const meter = new OrderFlowMeter(CFG.windowMs);
  const position = loadPosition();
  console.log(`▶  Replay ${file} — ${lines.length} trades — position: ${position ? position.side : "flat"}\n`);
  let consecutive = 0, fired = false;
  for (const line of lines) {
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const tick = classifyTrade(msg);
    meter.ingest(tick);
    const snap = meter.snapshot(tick.ts);
    const decision = evaluateExit(position, snap, CFG);
    consecutive = decision.exit ? consecutive + 1 : 0;
    if (!fired && decision.exit && consecutive >= CFG.confirmTicks) {
      fired = true;
      handleExit(position, snap, decision, { apply });
    }
  }
  if (!fired) console.log("no exit signal over this tape.");
}

// ─── Self-test: deterministic, offline, exercises the whole decision path ────

function selftest() {
  let pass = 0, fail = 0;
  const check = (name, cond) => { cond ? (pass++, console.log(`  ✓ ${name}`)) : (fail++, console.log(`  ✗ ${name}`)); };

  console.log("Order-flow exit watcher — self test\n");

  // 1. classifyTrade direction
  const buy = classifyTrade({ p: "100", q: "2", m: false, T: 1 });
  const sell = classifyTrade({ p: "100", q: "2", m: true, T: 1 });
  check("buyer-taker classified as aggressive BUY (+)", buy.signedQty === 2 && buy.side === "buy");
  check("buyer-maker classified as aggressive SELL (−)", sell.signedQty === -2 && sell.side === "sell");

  // 2. meter imbalance math
  const m = new OrderFlowMeter(10000);
  [ {p:"100",q:"6",m:false,T:1000}, {p:"100",q:"4",m:true,T:1001} ].forEach(x => m.ingest(classifyTrade(x)));
  const s = m.snapshot(1002);
  check("imbalance = (6−4)/10 = 0.2", Math.abs(s.imbalance - 0.2) < 1e-9);
  check("total notional summed", Math.abs(s.totalNotional - 1000) < 1e-9);

  // 3. window pruning
  const s2 = m.snapshot(20000);       // both ticks now older than window
  check("stale ticks pruned out of window", s2.trades === 0 && s2.imbalance === 0);

  const cfg = { ...CFG, threshold: 0.45, minNotional: 100, confirmTicks: 1 };

  // 4. LONG hurt by heavy sell flow
  const sellHeavy = { imbalance: -0.8, totalNotional: 500 };
  check("LONG exits on heavy SELL flow", evaluateExit({ side: "long", entryPrice: 100, quantity: 1 }, sellHeavy, cfg).exit === true);
  check("SHORT does NOT exit on heavy SELL flow", evaluateExit({ side: "short", entryPrice: 100, quantity: 1 }, sellHeavy, cfg).exit === false);

  // 5. SHORT hurt by heavy buy flow
  const buyHeavy = { imbalance: 0.8, totalNotional: 500 };
  check("SHORT exits on heavy BUY flow", evaluateExit({ side: "short", entryPrice: 100, quantity: 1 }, buyHeavy, cfg).exit === true);
  check("LONG does NOT exit on heavy BUY flow", evaluateExit({ side: "long", entryPrice: 100, quantity: 1 }, buyHeavy, cfg).exit === false);

  // 6. thin-tape guard
  check("thin tape blocks exit even at high pressure", evaluateExit({ side: "long", entryPrice: 100, quantity: 1 }, { imbalance: -0.9, totalNotional: 50 }, cfg).exit === false);

  // 7. no position → never exits
  check("flat book never exits", evaluateExit(null, sellHeavy, cfg).exit === false);

  // 8. simulated P&L signs
  const longPnl = simulateClose({ side: "long", entryPrice: 100, quantity: 2 }, 101, 0);
  const shortPnl = simulateClose({ side: "short", entryPrice: 100, quantity: 2 }, 99, 0);
  check("LONG close above entry is profit", Math.abs(longPnl.gross - 2) < 1e-9);
  check("SHORT close below entry is profit", Math.abs(shortPnl.gross - 2) < 1e-9);
  check("fee reduces net P&L", simulateClose({ side: "long", entryPrice: 100, quantity: 2 }, 101, 0.0008).net < longPnl.gross);

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

// ─── Entry ──────────────────────────────────────────────────────────────────

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const apply = flag("apply");
  const record = opt("record", null);
  const replay = opt("replay", null);
  if (flag("selftest")) selftest();
  else if (replay) runReplay(replay, { apply });
  else runLive({ apply, record });
}
