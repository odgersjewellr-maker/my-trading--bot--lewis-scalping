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
| `user_data/strategies/TrendPullbackStarter.py` | Mean-reversion starter strategy — see below |
| `user_data/strategies/TrendFollowingStarter.py` | Trend-following (Donchian breakout) strategy — see below |
| `user_data/strategies/SimpleTrendFilter.py` | 200-day SMA trend filter — the strongest result so far, see below |
| `user_data/data/binance/BTC_USDT-1d.feather` | Daily-resampled version of the same real data, for `SimpleTrendFilter` |
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

## The trend-following strategy — `TrendFollowingStarter`

Built after `TrendPullbackStarter`'s real backtest showed a mean-reversion edge doesn't hold on
BTC/USDT: the asset spent 2017-2024 mostly trending up hard (+1409%), and fading dips in a market
that mostly just keeps climbing gets you out right before the real move continues. This one buys
strength instead:

- **Regime filter (4h):** same EMA50/EMA200 filter as the pullback strategy — already-proven
  useful, kept as-is.
- **Entry (1h):** a Donchian-channel breakout — price closes above its highest high of the last
  20 candles (a genuine new local high), with 1h trend structure confirming (EMA20 > EMA50) and
  volume above its 20-period average so the breakout has real participation.
- **Exit:** a *narrower* Donchian channel (10-candle low) — the classic wide-entry/narrow-exit
  trend-system structure — plus a hard exit if 1h trend structure breaks or the 4h regime flips
  bearish. Deliberately **no profit-capping ROI table** (set to an effectively-unreachable 50%):
  trend systems make their money from a few large winners riding a trailing stop, and capping
  profit early is exactly what limited the pullback strategy's upside on its rare winners too.
- **Risk:** wider ATR-based trailing stop (~3x ATR, trend trades need room to breathe) with a
  hard -12% fallback.

**Real backtest results (same data, same offline pipeline as the pullback strategy):**

| Period | Trades | Win% | Total profit | Max drawdown | Sharpe | Profit factor | BTC buy-and-hold |
|---|---|---|---|---|---|---|---|
| 2017-08-17 → 2024-04-22 (full history) | 402 | 37.8% | **-9.85%** | 46.76% | -0.02 | 0.98 | +1409% |
| 2023-01-01 → 2024-04-22 (recent) | 96 | 34.4% | **+14.94%** | 22.68% | 0.55 | 1.14 | +292.88% |

**Reading this honestly:** the pivot from mean-reversion to trend-following clearly helped — full
history moved from -31% to -10%, and the recent window is genuinely positive with a positive
Sharpe and profit factor above 1. But two things keep this from being a real win: full-history
performance is still roughly breakeven (Sharpe ≈ 0, profit factor 0.98 — noise, not edge), and
even the positive recent window captured only a small fraction of BTC's own +293% run over the
same stretch, because the strategy is only in a position ~part of the time by design (avg trade
duration ~20h). Exit-reason breakdown makes the mechanism visible: trades that got out via the
trailing stop were net profitable (+39.5% aggregate, 42% win rate) — the winners running as
intended — while trades cut by the exit-signal (failed breakouts, trend structure breaking early)
lost money in aggregate (-49.4%, 28.5% win rate). That's the normal shape of a breakout system —
most breakouts fail — but it means the edge here, if any, is thin and depends on getting exactly
the balance right between "let winners run" and "cut failed breakouts fast," which a 40-epoch
hyperopt pass (same method as the pullback strategy) did not meaningfully improve: best in-sample
result was +3.31% over the full history with a **worse** drawdown (60.4%) than the untuned
version — again not committed, for the same overfitting reasons as before.

**Bottom line:** directionally the right pivot, not yet a strategy to trust with money. Better
than mean-reversion, still not clearing its own bar (beating simple buy-and-hold on a risk-adjusted
basis, consistently, out of sample).

## The strongest result so far — `SimpleTrendFilter`

Both strategies above are technical-indicator combinations on 1h/4h BTC — the most heavily
traded, most efficiently-priced pair that exists. That's a hard place to find a large edge:
if a real one were sitting in EMA/RSI/Donchian combinations on BTC/USDT, it would have been
arbitraged away years ago. Rather than keep adding filters to the same backtest until something
looked good (which manufactures a fake edge through overfitting, not a real one), the next
attempt went in the opposite direction: the single simplest, most academically-documented trend
rule that exists, with zero tunable parameters.

**The rule (Faber's "timing model," `A Quantitative Approach to Tactical Asset Allocation`,
2007):** be long BTC while its daily close is above its 200-day SMA, flat otherwise. One
indicator, one condition, no RSI/volume/ATR filters stacked on top, no hyperopt.

**The hypothesis being tested is narrower than "beat buy-and-hold":** buy-and-hold's own max
drawdown over 2017-2024 was **-83%** (computed directly from the same real data). Being flat
during the worst of the 2018 and 2022 bear markets, and only re-entering once a real uptrend
re-establishes, should cut into that brutal drawdown even at the cost of some whipsaw losses.

**Real result — genuinely strong, and it held up under scrutiny:**

| | SimpleTrendFilter | BTC buy-and-hold |
|---|---|---|
| Total return (2018-03 → 2024-04, post-warmup) | **+903%** | +711% |
| Max drawdown | **-64%** | -83% |
| Sharpe (daily) | **1.05** | — |
| Trades | 17 (4 win / 13 loss, 23.5% win rate) | — |
| Recent window (2023-01 → 2024-04) | +196% (Sharpe 2.04) | +302% |

Low win rate, but the 4 winners average **241 days held** — those are the multi-hundred-percent
BTC bull runs; the 13 losses are small whipsaws around the 200-day line during choppy
transitions. That shape — mostly small losses, occasionally a huge multi-month winner — is
exactly what a trend-following system is supposed to look like, and it's a structurally
different (and more credible) source of edge than the RSI/Donchian strategies above: it's not
predicting price, it's refusing to hold through the worst drawdowns.

**Why this one is more trustworthy, not just better-looking:** a 17-trade backtest would
normally be a yellow flag — not enough samples to distinguish signal from noise. The check that
matters here is whether the result is fragile to the exact parameter chosen. It isn't — re-running
with the SMA length swept from 100 to 300 days (100/150/200/250/300), every single one beat or
matched buy-and-hold's raw return while cutting max drawdown by 15-45 percentage points, and
Sharpe stayed positive (0.94-1.30) across the whole range:

| SMA length | Total return | Max drawdown | Sharpe |
|---|---|---|---|
| 100 | +1665% | -38% | 1.24 |
| 150 | +1915% | -45% | 1.30 |
| 200 | +903% | -64% | 1.05 |
| 250 | +704% | -65% | 0.95 |
| 300 | +706% | -68% | 0.94 |

A curve-fit result is fragile — it looks great at one specific parameter value and falls apart
just off it. A real effect is stable across a range. This one is stable, which is why it's the
strongest candidate found so far.

**Caveats, stated plainly, not hidden:**
- The "edge" here is really "avoid the two worst BTC bear markets in this specific historical
  window, ride the rest" — it is not a claim that a 200-day MA predicts anything. If BTC's future
  cycle structure changes (e.g. it matures into a choppier, more range-bound asset the way most
  traditional assets are), a system like this earns its keep through fewer, smaller whipsaws
  rather than large drawdown-avoidance payoffs — the historical edge could shrink.
- 17 trades over 6 years is inherent to this strategy's design (a long-horizon regime filter,
  not a high-frequency system) — it isn't a red flag by itself given the parameter-robustness
  check above, but it does mean "wait and see how the next full cycle plays out" is a reasonable
  posture before sizing this up.
- This only tested BTC/USDT spot, long-only, no leverage, no fees-beyond-Freqtrade's-default
  assumptions, and stops at April 2024 — extend the data (see below) before trusting this
  further.

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

**Without exchange access** (CI, this sandbox, offline dev), using the bundled real data. Note
`SimpleTrendFilter` runs on the `1d` timeframe — pass `--timeframe 1d` (or set it in your config)
when backtesting it, unlike the other two strategies which use `1h`:

```bash
python3 tools/offline_exchange_mock.py &

freqtrade backtesting --config user_data/config.json --config user_data/config-offline-backtest.json \
  --userdir user_data -s SimpleTrendFilter --timerange 20170817-20240422 --timeframe 1d
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

Three strategies tried on real 2017-2024 BTC/USDT data:

| Strategy | Full-history return | Max drawdown | Sharpe | Verdict |
|---|---|---|---|---|
| `TrendPullbackStarter` (mean-reversion) | -31.37% | 39% | -0.15 | Clear loser |
| `TrendFollowingStarter` (breakout) | -9.85% (~breakeven) | 47% | -0.02 | Not proven |
| `SimpleTrendFilter` (200-day SMA) | **+903%** (vs +711% buy-hold) | **64%** (vs 83% buy-hold) | **1.05** | Strongest so far, parameter-robust |

`SimpleTrendFilter` is the one worth building on. From here:

- **Extend the data past April 2024** (via `freqtrade download-data` on a machine with real
  access) before sizing this up — the current result stops before 2024-2026 price action, and a
  17-trade backtest deserves at least one more full cycle of out-of-sample data before trusting
  it with real capital.
- **Test the same rule on other large-cap pairs** (ETH/USDT, etc.) — if the drawdown-avoidance
  effect is real and not BTC-specific luck, it should show up there too with a similar shape
  (mostly small whipsaw losses, occasional huge trend-following winner).
- **Don't hyperopt this one.** Its credibility comes specifically from having zero tuned
  parameters and holding up across a wide, un-cherry-picked SMA range (100-300 days) — adding a
  hyperopt search over stoploss/exit variants now would reintroduce exactly the overfitting risk
  this approach was built to avoid.
- **Consider combining the two credible signals**: `SimpleTrendFilter`'s daily regime as the
  gate, with `TrendFollowingStarter`'s Donchian breakout for entry timing within that regime,
  now that both have been validated independently against the same real data.
- Once a strategy is actually sized up with confidence, this Freqtrade setup is also the
  foundation for running a fleet: Freqtrade supports multiple isolated instances (separate
  config/DB per strategy or pair) out of the box — the next piece is a shared risk manager across
  instances, not another cron job.
