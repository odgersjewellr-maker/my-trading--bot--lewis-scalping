# Session-direction study — London → New York continuation

Does the direction the market takes at the **London open** keep going through the
**New York open** that follows? This folder answers that empirically and lets you
re-run it on any symbol.

**→ Findings write-up: [`docs/research/london-ny-direction.md`](../../docs/research/london-ny-direction.md)**

TL;DR: at the NY *close* the London direction continues only ~50–53 % of the time
(a coin flip with a long-side tilt); in the first 1–2 h after the NY open it
mildly *reverses*; the one robust, tradeable asymmetry is **buying the NY-open dip
after a down London session** (~54 %). All edges are small enough that fees decide
P&L — use this as a filter, not a trigger.

## Files

| File | What it does |
|---|---|
| `analyze.mjs` | The study. Reads an OHLCV CSV (1-min or 1-h, plain or `.gz`), prints the report, writes `session-direction-results.{json,txt}`. Zero dependencies. |
| `triggers.mjs` | Entry-trigger lab: compares VWAP-reclaim, opening-range break, NY-open reclaim, and London sweep+reclaim vs naive baselines. Needs **1-minute** data (with volume). |
| `sweep-reclaim.mjs` | Deep-dive on the winning trigger (London sweep + reclaim) with a structural stop; per-year + long/short. Needs 1-minute data. |
| `fetch-hourly.js` | Pulls hourly candles from Binance to `<SYMBOL>-<INTERVAL>.csv` (run where Binance is reachable — your machine / Railway). |
| `session-direction-results.json` | Committed output from the BTC/USD 2012–2025 run, for reference. |

> The trigger scripts need **minute** data, not hourly. Grab the public Bitstamp
> set (option B below) or fetch 1-minute klines: `node fetch-hourly.js BTCUSDT 1m 2019-01-01`.

## Run it

```bash
# option A — your live venue (Binance), any symbol
node research/session-direction/fetch-hourly.js BTCUSDT 1h 2019-01-01
node research/session-direction/analyze.mjs BTCUSDT-1h.csv

# option B — the public Bitstamp minute dataset used for the write-up
curl -L -o btcusd_1min.csv.gz \
  https://raw.githubusercontent.com/ff137/bitstamp-btcusd-minute-data/main/data/historical/btcusd_bitstamp_1min_2012-2025.csv.gz
node research/session-direction/analyze.mjs btcusd_1min.csv.gz
```

## Configuration (env vars)

Session boundaries are **UTC hours**. Defaults model the classic London→NY handoff;
override them to test robustness (the write-up reports both `L_OPEN=7` and `L_OPEN=8`).

| Var | Default | Meaning |
|---|---|---|
| `L_OPEN` | `7` | London open hour (start of the London-led window) |
| `NY_OPEN` | `12` | New York open hour (the handoff boundary) |
| `NY_END` | `20` | end of the NY follow-through window |
| `START_YEAR` | `2019` | first year for the detailed stats |
| `WEEKDAYS_ONLY` | `1` | drop Sat/Sun (session effects are TradFi-driven) |
| `TREND_LOOKBACK` | `20` | days in the daily-trend-alignment filter |

```bash
# daylight-saving robustness check (London 08:00 / NY 13:00–21:00)
L_OPEN=8 NY_OPEN=13 NY_END=21 node research/session-direction/analyze.mjs BTCUSDT-1h.csv
```

> **DST note:** "London open" is 07:00 UTC in winter and 08:00 UTC in summer; "NY
> open" drifts the same way. Fixed UTC hours smear the true session by ±1 h — hence
> the two-definition robustness check. For production, anchor to *London local
> 08:00* / *New York local 09:30* instead of a fixed UTC hour.

## What it reports

1. **Headline continuation** at the NY close, per era, split by up- vs down-London.
2. **Decay curve** — continuation at NY-open + 1…8 h (finds the fade-early /
   reassert-late U-shape).
3. **Fade vs follow** gross expectancy with payoff asymmetry (the honesty check).
4. **Directional split** of the early fade (the long-bias buy-the-dip asymmetry).
5. **Trend-alignment filter** (does aligning London dir with the 20-day trend help?).
6. **NY-session volatility** for stop/target sizing.

## Input format

CSV with a timestamp column (`timestamp` / `time` / `date` / `datetime`, as unix
seconds, unix ms, or ISO string) plus `open,high,low,close` (case-insensitive,
any order). Binance klines and the Bitstamp dataset both work as-is.

## Caveats

Gross of fees; hourly-close continuation (no intrabar stop/target path); one
instrument/venue at a time. See §8 of the write-up. The next step is a proper
stop/target backtest — `analyze.mjs` already tracks each day's session high/low to
build one.
