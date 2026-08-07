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
| `requirements.txt` | Pinned `freqtrade` + `TA-Lib` versions |
| `docker-compose.yml` | Standard Freqtrade deploy pattern for a VPS |

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

### What was actually validated here, and what wasn't

This sandbox has no network access to exchange APIs (policy-blocked), so I could not download
real BTC/USDT data or run `freqtrade backtesting` against it. What I did validate, offline:

- `freqtrade list-strategies` — the strategy loads, resolves, and its hyperopt parameters are
  detected correctly (no import/syntax errors).
- A synthetic-data smoke test that replicates Freqtrade's own indicator/informative-merge
  pipeline caught and fixed **two real bugs** before you'd have hit them:
  1. The 4h→1h informative merge leaves leading `NaN`s wherever no 4h candle has closed yet,
     which turned `regime_bullish_4h` into a float column and crashed `~dataframe[...]` in the
     exit rule. Fixed with `.fillna(False).astype(bool)`.
  2. The entry condition originally required `RSI < 35` and `RSI turning up` and
     `close > EMA50` **all on the same candle** — which is nearly self-contradictory (an RSI
     dip deep enough to cross 35 on hourly data almost always also drags price under a
     similarly-lengthed EMA at that same candle). It produced **zero entries** across ~400 days
     of synthetic data and a hand-built textbook pullback alike. Fixed by using a 3-candle
     lookback for the oversold condition and an ATR-buffered floor instead of a hard EMA
     inequality.
- After the fixes: the strategy fires a plausible, non-degenerate number of times on synthetic
  data (not zero, not every candle), produces no NaNs post-warmup, and `custom_stoploss` returns
  sane values.

**What this does NOT tell you:** whether the strategy is actually profitable, what its
drawdown looks like, or whether 31-signals-on-fake-random-walk-data generalizes to real BTC
price action. Synthetic random-walk data lacks the volatility clustering and momentum
structure real markets have — it's a bug-catcher, not a performance signal. You must run a real
backtest before trusting this with money.

## Getting started (on a machine with internet access to Binance)

```bash
cd freqtrade-bot
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Pull real BTC/USDT history (1h entry + 4h informative timeframe)
freqtrade download-data --userdir user_data -p BTC/USDT -t 1h 4h --timerange 20230101-

# Confirm the strategy loads
freqtrade list-strategies --userdir user_data -v

# Real backtest — this is the number that actually matters
freqtrade backtesting --userdir user_data -s TrendPullbackStarter \
  --timerange 20230101- --breakdown month

# Optimize parameters with walk-forward validation, not by eyeballing one backtest
freqtrade hyperopt --userdir user_data -s TrendPullbackStarter \
  --hyperopt-loss SharpeHyperOptLoss --spaces buy sell -e 200

# Paper trade for real (config.json already has dry_run: true)
freqtrade trade --userdir user_data -s TrendPullbackStarter
```

Only flip `dry_run` to `false` in `user_data/config.json` — and add real API keys — after you've
watched it paper trade through more than one market regime.

## Deploying (VPS)

```bash
docker compose up -d
docker compose logs -f
```

## Next steps

- Run the real backtest above and look at the drawdown curve, not just total return — a single
  good-looking equity curve on one time window is the classic overfitting trap.
- Once this is validated, this Freqtrade setup is also the foundation for running a fleet:
  Freqtrade supports multiple isolated instances (separate config/DB per strategy or pair) out
  of the box — the next piece is a shared risk manager across instances, not another cron job.
