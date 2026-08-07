# freqtrade-bot — fresh start on Freqtrade

A clean rebuild on top of [Freqtrade](https://github.com/freqtrade/freqtrade) (53k★, the most
actively maintained open-source trading bot) instead of the hand-rolled `bot.js` engine
elsewhere in this repo. Freqtrade owns exchange connectivity, order management, realistic
backtesting (fees/slippage), hyperopt, dry-run, and multi-instance support — we only own the
strategy and risk logic, which is where the actual edge (or lack of one) lives.

**No bot is "highly profitable" out of the box.** This starter strategy exists to validate the
pipeline end-to-end and give you something concrete to iterate on — treat every number it
produces as a hypothesis to falsify, not a result to trust.

## What's here

| File | Purpose |
|---|---|
| `user_data/config.json` | BTC/USDT on Binance spot, `dry_run: true`, 1h timeframe |
| `user_data/strategies/TrendPullbackStarter.py` | Starter strategy — see below |
| `user_data/data/binance/BTC_USDT-{1h,4h}.feather` | Real BTC/USDT history, 2017-08-17 → 2024-04-22 — see [Data source](#data-source) |
| `user_data/config-offline-backtest.json` | Overlay config for backtesting without live exchange access — see [tools/](#tools) |
| `requirements.txt` | Pinned `freqtrade` + `TA-Lib` versions |
| `docker-compose.yml` | Standard Freqtrade deploy pattern for a VPS |
| `tools/offline_exchange_mock.py` | Local stub for Binance's metadata endpoint — see [tools/](#tools) |

## The starter strategy — `TrendPullbackStarter`

Long-only, BTC/USDT, 1h entries with a 4h regime filter:

- **Regime filter (4h):** only look for longs while EMA50 > EMA200 on the 4h chart. This is the
  piece the old 1m scalper elsewhere in this repo was missing — trading pullbacks against the
  higher-timeframe trend is what bleeds accounts in chop.
- **Entry (1h):** RSI(14) dipped below 35 in the last 3 candles and is now turning back up,
  while price hasn't broken down through EMA50 (with an ATR-sized buffer — see the comment in
  the code for why a hard `close > ema50` gate is nearly self-defeating).
- **Volatility filter:** skip entries when ATR% is abnormally low (dead market).
- **Risk:** ATR-based dynamic stoploss (`custom_stoploss`, ~2x ATR) with a hard -10% fallback,
  a trailing stop once +3% in profit, and a conservative ROI table that takes profit sooner as
  the trade ages.
- **Hyperoptable:** `rsi_buy_threshold`, `rsi_exit_threshold`, `atr_pct_min` are `IntParameter`/
  `DecimalParameter` — don't hand-tune them, run `freqtrade hyperopt` with walk-forward
  validation instead.

### What was actually validated here

This sandbox has no network access to exchange APIs (policy-blocked). Two rounds of validation
happened as a result:

**Round 1 — synthetic data (bug-catching only).** A smoke test that replicates Freqtrade's own
indicator/informative-merge pipeline caught and fixed two real bugs before you'd have hit them:
the 4h→1h merge left leading `NaN`s that crashed the exit rule's `~` operator, and the original
entry condition required RSI-oversold, RSI-turning-up, and price-above-EMA50 all on the *same
candle* — nearly self-contradictory, producing zero entries on ~400 days of data. Both fixed
(see the code comments in `TrendPullbackStarter.py`).

**Round 2 — real BTC/USDT data, real `freqtrade backtesting`/`hyperopt`.** Direct calls to
`api.binance.com` are blocked by this sandbox's network policy, but `raw.githubusercontent.com`
isn't — so real historical BTC/USDT data was pulled from a public GitHub-hosted CSV instead (see
[Data source](#data-source)), and a local stub (`tools/offline_exchange_mock.py`) answers
Freqtrade's one remaining exchange-metadata call so the *actual* Freqtrade backtesting engine —
not an approximation — could run against real prices.

**The honest result: as currently parameterized, this strategy loses money.**

| Period | Trades | Win% | Total profit | Max drawdown | Sharpe | BTC buy-and-hold |
|---|---|---|---|---|---|---|
| 2017-08-17 → 2024-04-22 (full history) | 128 | 43.0% | **-31.37%** | 39.25% | -0.15 | +1409% |
| 2023-01-01 → 2024-04-22 (recent) | 24 | 45.8% | **-6.46%** | 12.09% | -0.69 | — |

A 40-epoch hyperopt search (`SharpeHyperOptLoss`, buy+sell spaces, full history) found a best
in-sample result of +3.64% over 6.7 years from only **11 trades** — i.e. even generously tuned
within the parameter ranges defined in the strategy, this mean-reversion approach doesn't clear
noise, and 11 trades is nowhere near enough to trust as a real edge (classic overfitting
territory, not validated out-of-sample). The hyperopt params file from that run was deliberately
**not** committed here — don't treat it as "the" tuned settings.

**What this means:** the regime filter and bug fixes made the strategy *behave sanely*, not
*profitably*. Buying RSI dips in a 4h uptrend on BTC/USDT, over this specific 6.7-year window,
is not a real edge as implemented — it badly underperforms simply holding BTC, which is the bar
any active strategy has to clear to justify its own risk and effort. This is exactly the kind of
result the earlier warning about "no bot is highly profitable out of the box" was about: now
you have real numbers instead of a hope. Next step is iterating on the entry logic (or the whole
strategy family) against this real data — not tuning parameters further.

## Data source

`user_data/data/binance/BTC_USDT-{1h,4h}.feather` contains real Binance BTC/USDT OHLCV,
2017-08-17 → 2024-04-22 (~58k hourly candles, 30 minor gaps, no duplicates, verified OHLC
sanity). The 1h data was pulled from a public GitHub mirror
([amanb97/Time-Series-Analysis-of-Crypto-Currencies](https://github.com/amanb97/Time-Series-Analysis-of-Crypto-Currencies))
of [CryptoDataDownload.com](https://www.cryptodatadownload.com/)'s free historical exports, and
the 4h series is resampled from it. That source repo carries no explicit license — fine for
personal research/backtesting (which is what this is), but before relying on it for anything
more formal, re-pull the primary source directly with `freqtrade download-data` (below) on a
machine with real exchange access, and extend the range past April 2024.

## tools/

- **`offline_exchange_mock.py`** — a local stub answering only Binance's exchange-metadata
  endpoint (`exchangeInfo`), which Freqtrade calls even for fully local backtests. Lets
  `freqtrade backtesting`/`hyperopt` run in network-restricted environments using the bundled
  data. Never point live/dry-run `trade` mode at it — it doesn't serve real prices or orders.
- **`user_data/config-offline-backtest.json`** — overlay config wiring `ccxt` to the mock above.
  Use it alongside the real `config.json` via multiple `--config` flags (merged in order), as
  shown below.

## Getting started

**On a machine with internet access to Binance** (recommended — this is the real path):

```bash
cd freqtrade-bot
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Extend/refresh the bundled data past 2024-04-22, or pull it fresh
freqtrade download-data --userdir user_data -p BTC/USDT -t 1h 4h --timerange 20230101-

freqtrade backtesting --userdir user_data -s TrendPullbackStarter \
  --timerange 20230101- --breakdown month

freqtrade hyperopt --userdir user_data -s TrendPullbackStarter \
  --hyperopt-loss SharpeHyperOptLoss --spaces buy sell -e 200

# Paper trade for real (config.json already has dry_run: true)
freqtrade trade --userdir user_data -s TrendPullbackStarter
```

**Without exchange access** (CI, this sandbox, offline dev), using the bundled real data:

```bash
python3 tools/offline_exchange_mock.py &

freqtrade backtesting --config user_data/config.json --config user_data/config-offline-backtest.json \
  --userdir user_data -s TrendPullbackStarter --timerange 20170817-20240422
```

Only flip `dry_run` to `false` in `user_data/config.json` — and add real API keys — after you've
watched it paper trade through more than one market regime, on a strategy that's actually beaten
the backtest above.

## Deploying (VPS)

```bash
docker compose up -d
docker compose logs -f
```

## Next steps

`TrendPullbackStarter` as currently built loses money on real 2017-2024 data (see results
above) — it validated the pipeline, not an edge. From here:

- **Iterate on the entry logic itself**, not just its parameters — hyperopt within the existing
  buy/sell space already showed there's no meaningful edge hiding in this parameterization.
  Candidates worth trying: a genuine trend-following entry (buy strength, not dips) given BTC's
  strong upward drift over this period; a longer regime timeframe (1d instead of 4h); or
  dropping mean-reversion on BTC entirely in favor of a different pair/style.
- **Extend the data** past April 2024 (via `freqtrade download-data` on a machine with real
  access) before drawing any final conclusions — 2024-2026 price action isn't in this backtest.
- **Use walk-forward validation**, not a single in-sample hyperopt run, before trusting any
  parameter set — the 11-trade "best" epoch found here is a textbook overfitting warning, not a
  result.
- Once a strategy actually clears its own backtest with a real edge, this Freqtrade setup is
  also the foundation for running a fleet: Freqtrade supports multiple isolated instances
  (separate config/DB per strategy or pair) out of the box — the next piece is a shared risk
  manager across instances, not another cron job.
