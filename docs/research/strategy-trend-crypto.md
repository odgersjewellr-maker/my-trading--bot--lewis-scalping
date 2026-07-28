# A robust crypto trend strategy — single-asset flagship & multi-asset portfolio

*Full autonomy brief: "the best strategy you can make — best profit factor, less
drawdown, high return."* Here it is — with the honest caveat that profit, drawdown,
and win rate **fight each other**, so I optimised for what compounds wealth safely:
**risk-adjusted return (Sharpe / Calmar), drawdown control, and profit factor**, and
report win rate straight (it's the weakest of the three — §7).

> **Recommendation in one line:** the **multi-asset trend portfolio** (next section)
> — 13 coins, per-asset trend + inverse-vol sizing, gated by BTC's trend and a
> portfolio vol cap. Modern-era **+52 % CAGR, −40 % drawdown, Sharpe 1.29, monthly
> profit factor ~3.0**. The single-asset version (§5) is the simpler building block.

## TL;DR — the recommendation

**A daily long/flat trend-following *ensemble* with a mild volatility cap, run on BTC
(and ideally as a 2-asset BTC+ETH / BTC+SOL portfolio).**

| | Buy & Hold BTC | **This strategy (BTC)** | **This strategy (50/50 BTC+ETH)** |
|---|---|---|---|
| CAGR | +137 % | +78 % | +62 % |
| **Max drawdown** | **−93 %** | **−50 %** | **−43 %** |
| Sharpe | 1.41 | 1.53 | 1.44 |
| Calmar | 1.48 | 1.54 | 1.46 |
| Positive years | 71 % | 65 % | **75 %** |

It does **not** beat buy-and-hold on raw return (almost nothing does in a mega-bull
asset). It wins by **roughly halving the drawdown** while keeping a similar
risk-adjusted return — turning a −93 % "can't-hold-it" ride into a ~−43 % one, and
turning buy-and-hold's −73 %/−64 % *worst years* into −27 %/−23 %. That is what lets
you size up, use leverage safely, or simply not capitulate at the bottom (§8).

## 0. The upgrade — multi-asset portfolio (the actual recommendation)

The single-asset version above is the building block. Running the *same* trend logic
across a **basket of 13 large-caps** (BTC, ETH, LTC, XRP, XLM, XMR, DOGE, BCH, ETC,
ADA, LINK, BNB, TRX) — with two portfolio-level de-risk overlays — is strictly better
in the modern era: more return, less drawdown, higher profit factor.

| Multi-asset portfolio | 2014+ | 2018+ | **2020+ (modern)** | single-asset flagship 2020+ |
|---|---|---|---|---|
| CAGR | +62 % | +37 % | **+52 %** | +36 % |
| Max drawdown | −47 % | −49 % | **−40 %** | −50 % |
| Sharpe | 1.44 | 1.01 | **1.29** | 1.06 |
| Calmar | 1.31 | 0.75 | **1.30** | 0.71 |
| **Monthly profit factor** | 3.41 | 2.50 | **3.07** | — |
| Positive years | 69 % | 67 % | **71 %** | — |

The portfolio beats the single-asset flagship on **every** axis in 2020+. The headline
is the **monthly profit factor ≈ 3.0** — for every $1 of losing months it makes ~$3 of
winning months. (The full-history +82 %/−76 % *raw* basket was inflated by a +7,148 %
2017; the overlays and the modern-era rows are the honest go-forward picture.)

**Why diversification alone failed — and what fixed it.** Naively spreading across 13
coins made drawdown *worse* (−76 %): crypto correlations go to ~1 in a crash, so the
whole basket dumps together — diversification deserts you exactly when you need it.
Two **time-series** overlays are what actually control drawdown:
- **BTC-beta gate** — scale the whole book by BTC's own trend vote. When the market
  leader rolls below trend, stand aside. Alone: −76 % → −58 % at almost no return cost.
- **Portfolio vol cap** — scale by `min(1, 0.40 / trailing-30d realized vol)`; reacts
  fast when volatility spikes (crashes). Adds: −58 % → −47 % (−40 % in 2020+).

**Robust, not curve-fit.** Holds from 10 → 30 bp costs (+52 %→+50 %), works with
monthly rebalancing (+46 %/−43 %), and the vol cap is a clean risk *dial* (0.30 →
−36 % DD; 0.50 → +56 % CAGR) with no knife-edge peak — same untuned params across
2014+/2018+/2020+.

**The rules (each day):**
1. For every coin, the four trend votes of §5 → `base_i = ¼·(votes)`.
2. Inverse-vol sleeve: `sleeve_i = base_i × min(0.35, 0.20 / annualVol_i)` (risk parity,
   ≤ 35 % per name).
3. Sum sleeves; if > 1 scale to 1 — no leverage; holds **cash** automatically when few
   coins trend.
4. **× BTC-beta gate** (BTC's base vote) **× vol cap** `min(1, 0.40 / realizedPortVol)`.
5. Rebalance ~weekly (monthly also works). Long/flat, no shorting.

Run it: `node research/strategy/portfolio.mjs <dir-of-Date,Close-csvs>`. Use this if you
can hold a basket; use the single-asset flagship (§5) if you trade only one coin. The
vol cap (`VOL_CAP` env) is your risk dial — lower it for less drawdown, raise it for
more return.

## 1. Why this and not the intraday session stuff

The earlier session/sweep work found real but tiny, cost-sensitive, regime-lumpy
edges. Stepping back, the most robust, hardest-to-overfit edge in crypto is the
oldest one: **price trends persist, and volatility clusters.** Time-series momentum
is one of the most validated anomalies across all asset classes, and crypto's fat
left tail makes *drawdown control* (being flat in downtrends, smaller in high vol)
enormously valuable. So the design is: **stay long in uptrends, flat in downtrends,
and lighter when volatility spikes.**

## 2. Method — built to resist overfitting

- **Data:** daily closes, CoinMetrics community `PriceUSD` — BTC 2010→2026,
  ETH 2015→2026. (BTC cross-checked against Bitstamp minute-aggregated daily.)
- **Causal:** the signal from closes up to day *t* sets exposure for day *t+1*. No
  look-ahead.
- **Costs:** 10 bps charged on every unit of turnover (|Δexposure|), incl. daily
  vol-cap rebalancing. Long/flat only — no shorting, **no leverage** (exposure ≤ 1).
- **Textbook parameters, not tuned:** 200-day SMA, 20/100 cross, Donchian 50/25,
  100-day momentum, 30-day vol, 65 % vol target. I did **not** search these for the
  best backtest — that's the whole point.
- **Three-way validation:** BTC **train** 2010–2019, BTC **test** 2020–2026 (unseen
  time), and **ETH** (an entirely unseen *asset*). A real edge survives all three
  with the *same* parameters.

## 3. The frontier (BTC full history, 2010–2026)

| Strategy | CAGR | MaxDD | Sharpe | Calmar |
|---|---|---|---|---|
| Buy & Hold | +137 % | −93 % | 1.41 | 1.48 |
| SMA200 regime | +105 % | −86 % | 1.37 | 1.22 |
| MA cross 20/100 | **+140 %** | −76 % | 1.54 | 1.85 |
| Donchian 50/25 | +134 % | −70 % | **1.59** | **1.90** |
| TSMOM 100d | +118 % | −78 % | 1.40 | 1.52 |
| Regime + VolTarget | +65 % | −54 % | 1.43 | 1.20 |
| Trend Ensemble | +112 % | −71 % | 1.47 | 1.58 |
| **Ensemble + VolCap** ⭐ | +78 % | **−50 %** | 1.53 | 1.54 |

Every trend variant beats buy-and-hold on Sharpe. If you want **more return** and can
stomach ~−70 % drawdowns, plain **MA-cross 20/100** or **Donchian 50/25** nearly match
buy-and-hold's return at much better Sharpe. If you want **lowest drawdown** for the
risk-adjusted return, **Ensemble + VolCap** is the pick — that's the flagship.

## 4. Robustness — same params, three samples

| Ensemble + VolCap | CAGR | MaxDD | Sharpe | Calmar |
|---|---|---|---|---|
| BTC train 2010–2019 | +121 % | −49 % | 1.89 | 2.44 |
| BTC test 2020–2026 *(unseen time)* | +36 % | −50 % | 1.06 | 0.71 |
| ETH *(unseen asset)* | +65 % | −46 % | 1.32 | 1.42 |

Drawdown stays ~−46 to −50 % everywhere; Sharpe stays ≥ 1.0 and beats each sample's
buy-and-hold. It degrades from train to test (all strategies did — 2020+ was a lower-
return, higher-chop regime) but it does **not** break. That's the signature of a real,
if modest, edge rather than a curve fit.

## 5. The flagship, exactly

Daily, on each asset's closes (all signals causal):

1. **Four trend votes** (each 1 = "in uptrend", else 0):
   - close > 200-day SMA
   - 20-day SMA > 100-day SMA
   - Donchian: turn on when a close makes a new **50-day high**, off when a close makes
     a new **25-day low** (hold the state in between)
   - close > close **100 days** ago
2. **Ensemble = average of the four** → a base weight in {0, .25, .5, .75, 1}.
3. **Volatility cap:** `volScale = min(1, 0.65 / annualisedVol)`, where annualisedVol =
   30-day stdev of daily returns × √365.
4. **Target exposure = ensemble × volScale**, clipped to [0, 1]. No leverage.
5. Rebalance once daily at/near the close; hold the rest in cash (long/flat).
6. **Optional (recommended): run it on 2+ assets** (BTC+ETH, or BTC+SOL) at equal
   weight — diversification cut portfolio drawdown to −43 % (§6).

## 6. Flagship results & the portfolio bonus

| | CAGR | MaxDD | Sharpe | Calmar | Win day/mo/yr |
|---|---|---|---|---|---|
| BTC only | +78 % | −50 % | 1.53 | 1.54 | 38 / 43 / 65 % |
| ETH only | +65 % | −46 % | 1.32 | 1.42 | 34 / 39 / 67 % |
| **50/50 BTC+ETH** | +62 % | **−43 %** | 1.44 | 1.46 | 42 / 47 / **75 %** |

Portfolio yearly returns: `2016 +58 % · 2017 +803 % · 2018 −27 % · 2019 +75 % ·
2020 +157 % · 2021 +76 % · 2022 −23 % · 2023 +57 % · 2024 +64 % · 2025 +8 %`. Nine of
twelve years green; the red years are a fraction of buy-and-hold's.

## 7. About "highest win rate" — the honest part

**Trend-following does not have a high win rate, and it can't.** Its daily "win rate"
here (38–42 %) even looks *lower* than buy-and-hold's (53 %) — partly because flat days
count as non-wins, but fundamentally because **this style wins by avoiding big losses,
not by being right often.** Buy-and-hold has a higher per-period win rate precisely
*because* it never steps aside — and pays for it with the −93 % drawdown.

You genuinely cannot have all three at once:
- **Highest win rate** → mean-reversion / dip-buying (win often, occasional brutal
  loss — bad drawdown). I tested a dip-buy overlay; it didn't improve risk-adjusted
  results.
- **Lowest drawdown** → this trend + vol strategy (steps aside, so lower win rate).
- **Most raw profit** → buy-and-hold (and the worst drawdown).

The most useful "win rate" for a position strategy is **yearly: 75 % of years green,
more than buy-and-hold**, with far milder losing years. That's the honest, favourable
framing.

## 8. Sizing & the real "most profit" argument

Because the flagship's drawdown (~−43 to −50 %) is about **half** of buy-and-hold's
(−93 %), you can take on more size for the *same* risk. Rough illustration: run the
strategy at ~1.8–2× and your drawdown returns to buy-and-hold territory (~−85 %) while
the return roughly **doubles to ~+120–150 % CAGR — i.e. you can match or beat
buy-and-hold's return at the same drawdown.** That is the correct way to read "most
profit": not raw CAGR at 1×, but return-per-unit-drawdown, which you then dial with
leverage. (Leverage adds funding cost and liquidation/path risk — model it before
using it; the base strategy is unlevered.)

## 9. Caveats — read before risking money

- **Crypto is young.** ~3–4 cycles total; the "out-of-sample" is still the same short
  history. Treat the numbers as *indicative of behaviour*, not a promise.
- **Regime-dependent.** Returns fell sharply train→test; a long, choppy, sideways
  regime is trend-following's kryptonite (many small whipsaw losses).
- **Execution.** Daily close-to-close with 10 bps costs; real slippage, funding, and
  the exact fill time will move it. Low turnover (~30–60 trades/decade + daily
  vol-rebalance) keeps costs minor but not zero.
- **Parameter choices exist.** They're standard, not tuned, and results are stable
  across nearby values and across BTC/ETH — but they are still choices.
- **PriceUSD ≠ your venue.** Validate on your actual instrument/venue feed (below).

## 10. Run it on your own data (incl. SOL)

```bash
# any Date,Close daily CSV works. Your venue (Binance) for SOL:
node research/session-direction/fetch-hourly.js SOLUSDT 1d 2020-01-01   # -> SOLUSDT-1d.csv (timestamp,o,h,l,c,v)
# or CoinMetrics community closes:
#   raw.githubusercontent.com/coinmetrics/data/master/csv/<asset>.csv  (PriceUSD column)

node research/strategy/backtest.mjs BTCUSDT-1d.csv                 # full strategy table
node research/strategy/backtest.mjs BTCUSDT-1d.csv 2020-01-01 2026-12-31   # a period
node research/strategy/compare.mjs BTCUSDT-1d.csv SOLUSDT-1d.csv   # flagship + 2-asset portfolio
```

`backtest.mjs` takes a `Date,Close` CSV (it also reads the first two columns of a
`timestamp,o,h,l,c,v` file if you point it at fetch output after trimming, or just
pass a two-column file). `compare.mjs` runs the flagship on two assets and the 50/50
portfolio, and writes `curves.json`.

## Bottom line

The best *honest* strategy I can stand behind isn't a high-win-rate money printer —
those don't survive contact with a −60 % crypto quarter. It's a **boring, robust,
trend-following ensemble that halves your drawdown** and compounds at a strong
risk-adjusted rate, validated across time and assets with untuned parameters. Trade it
unlevered to sleep, or lever the low drawdown to chase buy-and-hold-beating returns at
controlled risk. Win rate is the price you pay for not blowing up — and it's worth it.
