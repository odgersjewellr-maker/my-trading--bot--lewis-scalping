# Opening Drive — a session-anchored day-trading strategy

A new, **deliberately uncorrelated** strategy to sit alongside the existing ones:

| Existing | Edge | Signal | Holding |
|----------|------|--------|---------|
| Neural Kernel Bands (`bot.js`) | trend/mean-reversion | kernel-band flips, 24/7 | days |
| VWAP+RSI(3)+EMA(8) (`rules.json`) | scalp snap-backs | indicator alignment, 24/7 | minutes |
| **Opening Drive (`opening-drive.js`)** | **time-of-day momentum** | **session open, once/day** | **intraday, flat overnight** |

The idea, in one line: **watch the pre-open, ride the strong direction that prints at the open, exit as it fades.**

---

## How it works

1. **Watch (pre-open).** Measure the lean over the `preOpenMins` before the open — this sets the day's **bias** (up or down).
2. **Frame (opening range).** The first `orMins` after the open build an **opening range** — its high and low.
3. **Trade the drive.** The first candle that **closes beyond the range** *in the direction of the pre-open bias* is the entry. That agreement is the "strong direction" filter — no bias agreement, no trade (toggle with `requireBiasAgree`).
4. **Exit as it fades.** Whichever comes first:
   - **Stop** — the far side of the opening range (initial risk), then **trailed** to each new bar's extreme as it runs.
   - **Fade** — a candle closes back *inside* the range (momentum gone).
   - **Time** — the drive window (`driveWindowMins`) ends; close and stay flat overnight.
   - **Target** — optional fixed take-profit in R multiples (`targetR`, off by default — let winners run/fade).
5. **One trade per day.** Day-trade discipline: one shot at the drive, no revenge trades, always flat by the afternoon.

## Which "open"? (the key design choice)

Crypto trades 24/7, so "the open" is a config value, not a bell:

- **`13:30` UTC (default)** = 09:30 New York — the US equity/ETF/CME open, where real institutional flow arrives. This is the closest thing crypto has to an *institutional* open and where an opening drive is most likely to exist.
- **`00:00` UTC** = the daily-candle open. **Not recommended for crypto** — see below.

`daily-drive-check.js` (runs on the daily data already in the repo) shows *why*: at the daily UTC boundary the mean overnight gap is **~0.004%** and gap direction predicts the day only **~50.7%** of the time — a coin flip. Because crypto is continuous, the daily open is just the prior close; there's no discontinuity to trade. That's the whole reason this strategy anchors to the **US open** instead, and why the daily boundary is the wrong place to look.

## Config knobs (`BASE_CFG` in `opening-drive.js`)

| Key | Default | Meaning |
|-----|---------|---------|
| `sessionOpenUTC` | `"13:30"` | the open, UTC |
| `preOpenMins` | `60` | pre-open watch window |
| `orMins` | `15` | opening-range length |
| `driveWindowMins` | `240` | how long the drive can last before force-flat |
| `requireBiasAgree` | `true` | breakout must agree with the pre-open lean |
| `minPreDriftPct` | `0` | minimum \|pre-open drift\| to call a direction |
| `stopAtRangeOpposite` | `true` | initial stop = far side of the range |
| `fadeExitOnClose` | `true` | exit when a candle closes back inside the range |
| `useTrail` | `true` | trail the stop to each bar's extreme |
| `targetR` | `0` | fixed take-profit in R (0 = disabled) |
| `weekdaysOnly` | `false` | skip weekends (US-open flow is a weekday thing) |
| `feePct` | `0.0006` | taker fee per side |

## Running it

```bash
# 1. Get intraday data (run where Binance is reachable — your VPS/laptop).
node fetch-binance-intraday.js BTCUSDT 15m 365

# 2. Backtest with defaults + full trade log.
node opening-drive.js btcusdt-15m-binance.csv

# 3. Grid-search OR length / drive window / stop / bias filter.
node opening-drive.js btcusdt-15m-binance.csv --optimize

# Verify the engine logic with no data at all:
node opening-drive.js --selftest
```

> **Data note.** Some hosted/CI environments block `api.binance.com` (this repo's cloud
> session does). Run the fetcher on your VPS or laptop — the same place `fetch-binance.js`
> already runs. The CSV format is `Timestamp,Open,High,Low,Close,Volume` with an ISO8601
> UTC timestamp, so any 15m source works.

## Workflow before risking money

1. `node opening-drive.js --selftest` — engine sanity (all paths asserted).
2. `node daily-drive-check.js` — confirms the daily boundary is dead (context).
3. Fetch 15m data, run the backtest on **BTC and SOL**, check the US open holds up.
4. `--optimize`, but treat the grid with suspicion — prefer settings that are stable across neighbours, not a single lucky cell.
5. Paper-trade the live version before going live. Never risk more than you can lose.

**This is not financial advice.**
