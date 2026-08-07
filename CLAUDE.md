# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install              # install deps (dotenv, node-fetch)

node bot.js               # run one check/trade cycle (reads env, may place a real order if PAPER_TRADING=false)
node bot.js --tax-summary # print trade totals/volume/fees from trades*.csv, no trading

node dashboard.js          # write dashboard.html once from local state files, then exit
node dashboard.js --serve  # serve a live-refreshing dashboard on localhost (SERVE_PORT), --no-open to skip auto-launch browser

node server.js             # start the TradingView webhook server (state read/written via GitHub Contents API, not local files)

node backtest.js           # grid-search backtest against btc-daily-binance.csv, ranks parameter sets by Sharpe
node backtest12m.js        # single/compare backtest runs over a 12-month window

node fetch-binance.js      # refresh btc-daily-binance.csv from Binance's public klines API

node hyrotrader-check.mjs [--order]     # HyroTrader (Bybit v5) adapter self-test, read-only unless --order
node velotrade-check.mjs                # Velotrade (DXtrade) adapter self-test
node hyrotrader-stoptest.mjs            # live entry → stop → amend → cancel → close round-trip on HyroTrader
```

There is no test suite or linter configured — nothing to run for `npm test`/`npm run lint`. Verifying a change means running the relevant script above (paper mode) and reading its console output, or running a backtest.

Local runs need a `.env` (copy `.env.example`); `bot.js` will scaffold one and refuse to run if `BITGET_API_KEY`/`SECRET`/`PASSPHRASE` are missing. GitHub Actions runs write `.env` themselves from repo secrets (see below) — never commit a real `.env`.

## Architecture

**The strategy actually running is not what `README.md`/`rules.json` describe.** Those document an earlier VWAP + RSI(3) + EMA(8) scalping strategy; the live logic in `bot.js` (and its backtest port) is **Neural Kernel Bands (NKB)** — a kernel-regression band indicator with an ADX trend filter, a 4H multi-timeframe filter, a volume filter, and an optional regime gate (chop/Markov). `neural-kernel-bands.pine` is the original TradingView Pine source the JS `calcNKB`/`calcNKBSeries` implementations are ported from — check it first when the JS math looks wrong. `backtest.js` and `backtest12m.js` each carry their **own independent copy** of the indicator math (ATR/EMA/ADX/NKB series functions) rather than importing from `bot.js`, so changes to the live indicator logic must be mirrored by hand into both backtest files or they silently drift out of sync.

**Multi-instance state via `INSTANCE_ID`.** `bot.js` derives a `FILE_KEY` from `INSTANCE_ID` (falling back to `SYMBOL`) and scopes every state file to it: `safety-check-log-{KEY}.json`, `position-{KEY}.json`, `portfolio-{KEY}.json`, `nkb-state-{KEY}.json`, `prop-state-{KEY}.json`, `trades-{KEY}.csv`. This is what lets multiple "books" trade the same symbol under different rules without sharing state (e.g. `SOLUSDT` live-paper vs `SOLUSDT-PROP` challenge book, or `BTCUSDT` 15m vs `BTCUSDT-DAILY`).

**Broker execution is dispatched two ways.** For normal spot/futures trading, `bot.js` signs and calls BitGet's REST API directly (`placeBitGetOrder`, `signBitGet`, `setLeverage`). For prop-firm challenge accounts, `BROKER=velotrade|hyrotrader` switches `bot.js` onto the `PROP_EXEC` shim, which dispatches to `velotrade.js` (DXtrade) or `hyrotrader.js` (Bybit v5) — both implement the same interface (`placeMarket`, `placeStop`, `replaceStop`, `safeCancelStop`, `accountMetrics`, `hasOpenPosition`) so `bot.js`'s prop logic (drawdown guards, daily-loss guard, leverage cap) stays broker-agnostic. Paper mode (`PAPER_TRADING=true`) never calls any broker.

**GitHub Actions is the production scheduler**, not a long-running process. `.github/workflows/run-bot.yml` cron-fires every 15 minutes with separate jobs per book (`run-btc`, `run-sol-prop`, `run-sol`), each with its own `concurrency.group`; a second workflow runs the `BTCUSDT-DAILY` book once a day just after the daily candle closes. Each job writes a fresh `.env` from repo secrets + inline config, runs `node bot.js` once (fire-and-exit), then commits and pushes any changed instance-scoped state files back to the repo (with a fetch/rebase/retry loop on push rejection) so the next scheduled run picks up where the last left off. A `keepalive.yml` workflow re-enables the schedule weekly in case GitHub auto-pauses it from inactivity.

**`server.js` is a separate, alternate execution path**, not the same as `bot.js`'s local runs: it's a persistent webhook server (e.g. deployed to Railway) that TradingView alerts POST to for instant execution instead of waiting for the next cron tick, and it reads/writes state through the **GitHub Contents API** (`ghGet`/`ghPut`) rather than the local filesystem — so it stays consistent with the state the cron-driven `bot.js` runs are committing. It imports config and helpers directly from `bot.js` (`CONFIG`, `fetchCandles`, `signBitGet`, `computeStopLossPrice`, `setLeverage`).

**`dashboard.js` is unrelated to `server.js`'s dashboard** — it reads state files off the local disk (not GitHub), for local or VPS use, and can either write `dashboard.html` once or serve a self-refreshing page.

**`railway-hyro/`** is a separate Dockerized deployment of the HyroTrader prop-trial bot for Railway (own `loop.mjs` scheduler); its README notes current deployment status — check it before assuming this path is active, and never run it alongside the equivalent PC scheduled task simultaneously (double-trade risk).

**Safety/risk gating is layered**, independent of the strategy signal itself: daily trade-count cap, max trade size, 1%-of-portfolio position sizing, an ADX entry-strength gate, a regime gate (chop/Markov, entries only, never blocks exits), and — for prop-mode books — a drawdown guard and daily-loss guard that flatten and halt trading at a configurable fraction of the firm's limits. Every decision (pass or fail, with actual indicator values) is written to the instance's `safety-check-log-*.json`, and every executed trade to its `trades-*.csv` in the tax-ready column layout described in `README.md`.
