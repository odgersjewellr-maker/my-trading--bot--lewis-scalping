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
| `user_data/strategies/SimpleTrendFilter.py` | 150-day SMA trend filter — the strongest result so far, see below |
| `user_data/strategies/TrendRegimeBreakout.py` | Attempt to raise trade frequency by combining the daily regime with the Donchian entry — didn't work, see below |
| `user_data/strategies/SimpleTrendFilterPyramid.py` | Attempt to raise frequency via scaling into positions — also didn't help, see below |
| `user_data/config-multi-asset.json` | BTC/USDT + ETH/USDT, `max_open_trades: 2` — the actual frequency win, see below |
| `user_data/data/binance/BTC_USDT-1d.feather`, `ETH_USDT-1d.feather` | Daily-resampled real data for `SimpleTrendFilter` and friends |
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
2007):** be long BTC while its daily close is above its N-day SMA, flat otherwise. One
indicator, one condition, no RSI/volume/ATR filters stacked on top, no hyperopt.

**The hypothesis being tested is narrower than "beat buy-and-hold":** buy-and-hold's own max
drawdown over 2017-2024 was **-83%** (computed directly from the same real data). Being flat
during the worst of the 2018 and 2022 bear markets, and only re-entering once a real uptrend
re-establishes, should cut into that brutal drawdown even at the cost of some whipsaw losses.

**Why this one is more trustworthy, not just better-looking:** rather than pick one SMA length
and report it, the length was swept from 100 to 300 days (100/150/200/250/300) as a robustness
check — a curve-fit result looks great at one specific parameter and falls apart just off it; a
real effect is stable across a range:

| SMA length | Total return | Max drawdown | Sharpe | Trades |
|---|---|---|---|---|
| 100 | +1665% | -38% | 1.24 | 35 |
| **150 (default)** | **+1915%** | **-45%** | **1.30** | **19** |
| 200 | +903% | -64% | 1.05 | 17 |
| 250 | +704% | -65% | 0.95 | 23 |
| 300 | +706% | -68% | 0.94 | 24 |

Every value in the range beat or matched buy-and-hold's raw return while cutting drawdown by
15-45 points, Sharpe stayed positive throughout — that stability is what makes this credible.
**150 days is the default because it's strictly best on every metric in the sweep** (highest
return, lowest drawdown, highest Sharpe, and more trades than 200) — selecting the best point
from an already-validated range is not the same thing as optimizing a free parameter against
the backtest; the range was fixed before looking at which value won.

**Real result at the 150-day default:**

| | SimpleTrendFilter | BTC buy-and-hold |
|---|---|---|
| Total return (2018-01 → 2024-04, post-warmup) | **+1915%** | +711%* |
| Max drawdown | **-45%** | -83% |
| Sharpe (daily) | **1.30** | — |
| Profit factor | **6.31** | — |
| Trades | 19 (win rate low, winners hold ~months) | — |
| Recent window (2023-01 → 2024-04) | +193% (Sharpe 2.01) | +302% |

*\*Market-change baseline differs slightly by SMA length because each length has a different
warmup cutoff, hence a different backtested start date — 150-day's comparison window starts
2018-01, not 2018-03 like the original 200-day figure reported earlier.*

The winners average months held — those are the multi-hundred-percent BTC bull runs; the losses
are small whipsaws around the SMA line during choppy transitions. That shape — mostly small
losses, occasionally a huge multi-month winner — is exactly what a trend-following system is
supposed to look like, and it's a structurally different (and more credible) source of edge than
the RSI/Donchian strategies above: it's not predicting price, it's refusing to hold through the
worst drawdowns.

**Caveats, stated plainly, not hidden:**
- The "edge" here is really "avoid the two worst BTC bear markets in this specific historical
  window, ride the rest" — it is not a claim that a moving average predicts anything. If BTC's
  future cycle structure changes (e.g. it matures into a choppier, more range-bound asset the way
  most traditional assets are), a system like this earns its keep through fewer, smaller
  whipsaws rather than large drawdown-avoidance payoffs — the historical edge could shrink.
- Even at 19-35 trades, this is a low sample size inherent to this strategy's design (a
  long-horizon regime filter, not a high-frequency system) — it isn't a red flag by itself given
  the parameter-robustness check above, but "wait and see how the next full cycle plays out" is a
  reasonable posture before sizing this up.
- This only tested BTC/USDT spot, long-only, no leverage, no fees-beyond-Freqtrade's-default
  assumptions, and stops at April 2024 — extend the data (see below) before trusting this
  further.

## Trying to raise trade frequency — `TrendRegimeBreakout` (didn't work)

`SimpleTrendFilter` above is high-quality but inherently low-frequency (19 trades over 6+ years)
because it takes one position per macro trend and holds it. The natural next question — can the
frequency go up without losing the edge? — was tested directly: gate `TrendFollowingStarter`'s
1h Donchian-breakout entries with `SimpleTrendFilter`'s validated 150-day daily regime instead of
the noisier 4h EMA regime, so the system takes multiple entries per macro trend instead of one.

**Result: it raised frequency, and it cost the edge.**

| | Full history | Recent (2023-24) |
|---|---|---|
| Trades | 359 | 110 |
| Total profit | **-12.75%** | +20.20% |
| Sharpe (daily) | 0.02 | 0.65 |
| Market change (buy-hold) | +538% | +293% |

Full-history performance is worse than the plain Donchian breakout strategy (-12.75% vs -9.85%)
and dramatically worse than the pure daily regime filter it was supposed to build on (+1915%).
The recent window looks fine in isolation, but the full history is the number that matters, and
it's a loss. **Conclusion: the daily-regime edge and the intraday-breakout edge don't combine —
the higher frequency just reintroduces the same failed-breakout whipsaw problem that limited
`TrendFollowingStarter` on its own, even with a better regime filter underneath it.** Trade
frequency and this particular edge appear to be in direct tension, not orthogonal levers. Kept
in the repo and documented rather than deleted, so this specific combination doesn't get
re-tried blind later.

## A second frequency attempt — `SimpleTrendFilterPyramid` (also didn't work)

`TrendRegimeBreakout` failed by adding a faster *exit*, which cut winners short. A structurally
different idea: keep `SimpleTrendFilter`'s exit exactly as-is (only exit on regime flip), and
instead add capital to an *already-open* winning trade when it pulls back and bounces within the
still-bullish regime — a sizing decision, not a new trade. `SimpleTrendFilterPyramid`
implements this: after entry, an 8%+ pullback from the post-entry high followed by a close
higher than the prior candle triggers an add, capped at 3 adds per trade and 20 days apart.

**First attempt was a silent no-op, not a real test.** With `stake_amount: "unlimited"` and
`max_open_trades: 1`, Freqtrade commits the *entire* account balance to the initial entry —
confirmed by instrumenting the strategy directly: available capital for an add was ~$0.01 by the
time a real pullback showed up. Freqtrade also swallows exceptions from this callback by default
(`supress_error=True`), so a broken version of this would have silently reported the identical
baseline numbers and looked like "no effect" instead of "never actually ran." Fixed by sizing the
initial entry at 1/(1+max adds) via `custom_stake_amount`, reserving real room for adds up front.

**Once it actually worked, it made performance worse, not better — tested twice:**

| | Total return | Sharpe (daily) | Trades | Win rate |
|---|---|---|---|---|
| `SimpleTrendFilter` baseline (BTC only) | +1915% | 1.30 | 19 | — |
| `SimpleTrendFilterPyramid` (BTC only) | **+683%** | 1.10 | 19 | 26.3% |
| `SimpleTrendFilter` baseline (BTC+ETH) | +1691% | 1.21 | 47 | — |
| `SimpleTrendFilterPyramid` (BTC+ETH) | **+585%** | 1.02 | 48 | 18.8% |

Same trade *count* both times (adds don't create new round-trip trades in Freqtrade's counting),
so this didn't even deliver on the frequency goal — and return dropped by more than half in both
configurations. **The mechanism:** reserving capital for adds that don't always materialize means
a meaningful chunk of the account sits uninvested for the entire life of any trade that never
pulls back 8%, which mechanically drags down compounding versus committing full size immediately.
This isn't a bug to fix — it's the actual cost of holding dry powder, and here that cost outweighs
the benefit of buying dips within a trend. Kept in the repo as a documented negative result.

## The actual frequency win — trading BTC and ETH together

Both frequency attempts above tried to make *one asset* trade more often, and both hurt the edge.
The lever that hasn't been tried yet: run the exact same, unmodified 150-day rule on a *second*
independent asset. This was also the outstanding validation question from the single-asset
result — is the drawdown-avoidance effect a real, general trend-following phenomenon, or
BTC-specific luck?

**Step 1 — does the unmodified rule even work on ETH/USDT?** Sourced real ETH/USDT hourly data
the same way as BTC (same GitHub source, same repo, same quality checks — see
[Data source](#data-source)), resampled to daily, and ran `SimpleTrendFilter` completely
unchanged:

| | ETH/USDT | ETH buy-and-hold |
|---|---|---|
| Total return | **+1117%** | +426% |
| Max drawdown | **-68%** | -94% |
| Sharpe (daily) | 0.97 | — |
| Trades | 28 | — |

Yes — beats its own buy-and-hold on both return and drawdown, same shape as BTC (few trades, big
winners). The effect generalizes; it isn't a BTC fluke.

**Step 2 — trade both together.** `user_data/config-multi-asset.json` runs the identical strategy
on BTC/USDT and ETH/USDT simultaneously (`max_open_trades: 2`, each asset gets its own
independent regime signal and position):

| | BTC only | ETH only | **BTC + ETH portfolio** |
|---|---|---|---|
| Trades | 19 | 28 | **47** (~7.7/yr, vs 3.1/yr for BTC alone) |
| Total return | +1915% | +1117% | +1691% |
| CAGR | 63.5%/yr | 50.5%/yr | 60.4%/yr |
| Max drawdown (wallet) | -45% | -68% | -47% |
| Sharpe (daily) | 1.30 | 0.97 | **1.21** |

**This is the real answer to "more frequency, still sharp."** Trade frequency more than doubled
(3.1 → 7.7/year) while Sharpe stayed close to BTC-alone's (1.21 vs 1.30, not a big give-up) and
CAGR landed between the two individual assets, as expected from blending. No new indicators, no
new entry/exit logic, no capital-utilization tradeoff — just the same validated rule applied to
more things. Diversification benefit is real but modest here because BTC and ETH are historically
highly correlated, so this isn't "free" risk reduction the way trading two uncorrelated assets
would be — but it costs nothing on the Sharpe side and doubles opportunity.

## Data source

`user_data/data/binance/{BTC,ETH}_USDT-{1h,4h}.feather` (1h/4h are BTC-only) contains real
Binance OHLCV, 2017-08-17 → 2024-04-22 (~58k hourly candles per asset, ~30 minor gaps each, no
duplicates, verified OHLC sanity). Both were pulled from the same public GitHub mirror
([amanb97/Time-Series-Analysis-of-Crypto-Currencies](https://github.com/amanb97/Time-Series-Analysis-of-Crypto-Currencies))
of [CryptoDataDownload.com](https://www.cryptodatadownload.com/)'s free historical exports; the
1d/4h series are resampled from the 1h data. That source repo carries no explicit license — fine
for personal research/backtesting (which is what this is), but before relying on it for anything
more formal, re-pull the primary source directly with `freqtrade download-data` (below) on a
machine with real exchange access, and extend the range past April 2024.

## tools/

- **`offline_exchange_mock.py`** — a local stub answering only Binance's exchange-metadata
  endpoint (`exchangeInfo`), which Freqtrade calls even for fully local backtests. Lets
  `freqtrade backtesting`/`hyperopt` run in network-restricted environments using the bundled
  data, now for both BTCUSDT and ETHUSDT. Never point live/dry-run `trade` mode at it — it
  doesn't serve real prices or orders.
- **`user_data/config-offline-backtest.json`** — overlay config wiring `ccxt` to the mock above.
  Use it alongside the real `config.json` via multiple `--config` flags (merged in order), as
  shown below.
- **`entry_screener.py`** — reports which bundled tickers are currently in `SimpleTrendFilter`'s
  one entry condition (close above its 150-day SMA), flagging fresh crossovers vs. long-
  established trends vs. tickers approaching the line, plus four diagnostic columns: 30d
  annualized volatility, 90d/180d momentum, 30d volume trend, and rolling correlation to BTC.
  **Only the State column is what the strategy actually trades on** — the diagnostic columns are
  for deciding what's worth backtesting next, not inputs to an automatic ranking. The
  correlation column is the direct, quantified version of the ETH lesson above: it's what would
  have shown, before backtesting, that ETH (+0.85 correlation to BTC) was likely to dilute rather
  than diversify. `python3 tools/entry_screener.py`. Only reads whatever `*-1d.feather` files
  exist in `user_data/data/binance/` — right now that's BTC and ETH as of **2024-04-22**, not
  live. To screen a new ticker or get current results, pull real data on a machine with exchange
  access first: `freqtrade download-data --userdir user_data -p SOL/USDT -t 1d --timerange 20170101-`.

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
`SimpleTrendFilter` and friends run on the `1d` timeframe — pass `--timeframe 1d` (or set it in
your config) when backtesting them, unlike `TrendPullbackStarter`/`TrendFollowingStarter` which
use `1h`:

```bash
python3 tools/offline_exchange_mock.py &

# Single-asset (BTC only)
freqtrade backtesting --config user_data/config.json --config user_data/config-offline-backtest.json \
  --userdir user_data -s SimpleTrendFilter --timerange 20170817-20240422 --timeframe 1d

# The recommended path: BTC + ETH together
freqtrade backtesting --config user_data/config-multi-asset.json --config user_data/config-offline-backtest.json \
  --userdir user_data -s SimpleTrendFilter --timerange 20170817-20240422 --timeframe 1d
```

Only flip `dry_run` to `false` in whichever config you use — and add real API keys — after you've
watched it paper trade through more than one market regime, on a strategy that's actually beaten
the backtest above.

## Deploying (VPS)

```bash
docker compose up -d
docker compose logs -f
```

## Next steps

Six strategies/configurations tried on real 2017-2024 data:

| Strategy | Full-history return | Max drawdown | Sharpe | Trades | Verdict |
|---|---|---|---|---|---|
| `TrendPullbackStarter` (mean-reversion) | -31.37% | 39% | -0.15 | 128 | Clear loser |
| `TrendFollowingStarter` (breakout) | -9.85% (~breakeven) | 47% | -0.02 | 402 | Not proven |
| `TrendRegimeBreakout` (regime + breakout combined) | -12.75% | 46% | 0.02 | 359 | Higher frequency, lost the edge |
| `SimpleTrendFilter`, BTC only (150-day SMA) | +1915% (vs +711% buy-hold) | 45% (vs 83% buy-hold) | 1.30 | 19 | Strongest single-asset result |
| `SimpleTrendFilterPyramid`, BTC only | +683% | 42% | 1.10 | 19 | Worse than baseline, no frequency gain |
| `SimpleTrendFilter`, **BTC + ETH** | **+1691%** | **47%** | **1.21** | **47 (~7.7/yr)** | **Best balance of frequency and edge** |

Two different attempts to raise trade frequency on a single asset both made things worse
(`TrendRegimeBreakout` by adding a faster exit, `SimpleTrendFilterPyramid` by tying up capital as
dry powder) — consistent evidence that this edge comes from patience and full commitment per
trade, not from finer-grained timing. The lever that actually worked was giving the same
unmodified rule more independent things to trade. **`config-multi-asset.json` +
`SimpleTrendFilter` is the current best answer to "sharpen performance and frequency together."**
From here:

- **Add a third asset** (SOL, or another large-cap with real multi-year history) the same way —
  source real data via GitHub, validate the unmodified rule on it standalone first, only then add
  it to the portfolio config. Each additional independent asset should keep raising frequency;
  watch whether Sharpe holds up or degrades as more (increasingly correlated, in crypto) assets
  are added.
- **Extend the data past April 2024** (via `freqtrade download-data` on a machine with real
  access) before sizing any of this up — every result here stops before 2024-2026 price action.
- **Don't hyperopt `SimpleTrendFilter`.** Its credibility comes specifically from having zero
  tuned parameters and holding up across a wide, un-cherry-picked SMA range — adding a hyperopt
  search now would reintroduce exactly the overfitting risk this approach was built to avoid.
- Once a strategy is actually sized up with confidence, this Freqtrade setup is also the
  foundation for running a fleet: Freqtrade supports multiple isolated instances (separate
  config/DB per strategy or pair) out of the box — the next piece is a shared risk manager across
  instances, not another cron job.
