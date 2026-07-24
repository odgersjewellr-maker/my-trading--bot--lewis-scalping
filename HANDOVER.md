# Handover Brief — Order-Flow Exit Watcher

## 1. Purpose
The trading bot (`bot.js`) enters and exits on **candle** indicators (EMA/VWAP/RSI).
Candles discard order flow, so the bot can't see *who* is aggressing the tape. This
watcher fills that gap: it reads the live trade tape and raises an **early-exit signal
when order flow turns decisively against an open position** — sooner than the bot's
lagging RSI(3)-crosses-50 exit. It's a risk/exit tool, not an entry tool.

## 2. What it is
- **One standalone file:** `flow-exit-watcher.js`. A long-running process, *separate*
  from the cron bot.
- **Data source:** Binance **public** mainnet aggTrade websocket. No API key,
  read-only market data, **zero execution risk**.
- **No new dependencies** — native WebSocket in Node 22.

## 3. How it works
1. Subscribes to `wss://stream.binance.com:9443/ws/<symbol>@aggTrade`.
2. Each trade's `m` flag gives the aggressor side (buyer-maker ⇒ aggressive **sell**;
   buyer-taker ⇒ aggressive **buy**).
3. A rolling **order-flow imbalance** meter (default 5s window) scores buy vs sell
   pressure in [−1, +1].
4. It reads the bot's `position-<KEY>.json`. For a **long**, heavy sell pressure is
   adverse; for a **short**, heavy buy pressure is adverse.
5. When adverse pressure exceeds the threshold, on a tape thick enough to trust, for
   N consecutive checks → it fires.

## 4. Safety model — important
- **Advisory / non-destructive by default.** On a signal it logs a simulated close and
  writes `flow-exit-signal-<KEY>.json` / `flow-exit-log-<KEY>.json`. It **does not touch
  the bot's position file.**
- Only `--apply` (opt-in) flattens the paper position so the cron bot sees a flat book.
- It cannot interfere with a running bot test in default mode — it only *reads*.

## 5. How to run
```bash
# Live (advisory) — needs open outbound network (VPS, not the Claude sandbox)
SYMBOL=SOLUSDT node flow-exit-watcher.js

# Live + record the tape for later replay
SYMBOL=SOLUSDT node flow-exit-watcher.js --record tape.jsonl

# Offline deterministic logic test
node flow-exit-watcher.js --selftest

# Replay a recorded/synthetic tape through the full pipeline
SYMBOL=SOLUSDT node flow-exit-watcher.js --replay tape.jsonl

# Opt-in: actually flatten the paper position on a signal
SYMBOL=SOLUSDT node flow-exit-watcher.js --apply
```

## 6. Configuration (env vars, all optional)
| Var | Default | Meaning |
|---|---|---|
| `SYMBOL` | BTCUSDT | pair to watch (also picks the position file) |
| `INSTANCE_ID` | — | override position-file key (matches bot.js) |
| `FLOW_WINDOW_MS` | 5000 | rolling imbalance window |
| `FLOW_IMBALANCE_THRESHOLD` | 0.45 | adverse pressure needed to trip |
| `FLOW_MIN_NOTIONAL_USD` | 50000 | thin-tape guard — raise for BTC, lower for thin pairs |
| `FLOW_CONFIRM_TICKS` | 3 | consecutive adverse checks before firing (noise damper) |
| `FLOW_CHECK_INTERVAL_MS` | 1000 | evaluation cadence |
| `PAPER_FEE_RATE` | 0.0008 | fee+slippage for simulated P&L |

## 7. Current status — tested
- **`--selftest`: 14/14 pass** (classification, imbalance math, window pruning,
  side-aware exit, thin-tape guard, P&L signs).
- **Replay vs the live short (`position-SOLUSDT.json`):** fired correctly at mark 76.05
  vs a tape running to 76.42 — capped a loss that would've been ≈ −$5.74 at −$0.91;
  position file left untouched.
- **Negative case** (sell-pressure, favourable for the short): correctly produced **no**
  signal.

## 8. Known limitation
- **The live socket can't run from the Claude sandbox** — the network policy blocks
  `binance.com` (websocket non-101; REST `403 CONNECT tunnel failed`). Everything but the
  raw socket is proven offline via `--replay`. **Run the live test on the VPS.**

## 9. Open next steps (not started — owner's call)
1. **Live smoke test on the VPS** to confirm the real stream matches replay behaviour.
2. **Threshold tuning per symbol** using `--record` tapes from real sessions.
3. **Optional bot integration:** route an `--apply` exit into the bot's `trades.csv` /
   `safety-check-log` so a flow exit lands in the tax record like any other trade.
   *This edits `bot.js` — deferred until testing is done and approved.*

## 10. Files
- `flow-exit-watcher.js` (new) — the watcher.
- `.gitignore` — ignores the two generated `flow-exit-*` runtime files.
- `bot.js` and its state files: **untouched.**
