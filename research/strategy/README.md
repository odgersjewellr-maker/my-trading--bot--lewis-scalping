# Trend-ensemble strategy (daily, long/flat)

The best *risk-adjusted* strategy from this research: a daily trend-following ensemble
with a mild volatility cap. Roughly **halves buy-and-hold's drawdown** (−93 % → ~−43 to
−50 %) at a similar or better Sharpe/Calmar, validated on BTC train/test **and** ETH
(out-of-sample asset) with untuned, textbook parameters.

**→ Full write-up & honest caveats: [`docs/research/strategy-trend-crypto.md`](../../docs/research/strategy-trend-crypto.md)**

## Files

| File | What it does |
|---|---|
| **`portfolio.mjs`** ⭐ | **The recommended strategy.** Multi-asset trend portfolio: per-coin trend ensemble → inverse-vol sleeves, gated by BTC's trend and a portfolio vol cap. Prints CAGR / MaxDD / Sharpe / Sortino / Calmar / **profit factor** / win rates. Modern-era +52% CAGR, −40% DD, PF ~3.0. |
| `backtest.mjs` | Single-asset engine + strategy library (buy&hold, SMA200, MA-cross, Donchian, TSMOM, vol-target, ensemble, ensemble+vol-cap). CAGR / MaxDD / Sharpe / Sortino / Calmar / win% / exposure / trades. |
| `compare.mjs` | Runs the single-asset flagship on two assets and a 50/50 portfolio; monthly/yearly win rates; writes `curves.json`. |

## Recommended: the multi-asset portfolio

```bash
# fetch a basket of daily closes (CoinMetrics community, PriceUSD column):
mkdir uni && for a in btc eth ltc xrp xlm xmr doge bch etc ada link bnb trx; do
  curl -sL "https://raw.githubusercontent.com/coinmetrics/data/master/csv/$a.csv" \
  | awk -F, 'NR==1{for(i=1;i<=NF;i++)if($i=="PriceUSD")p=i;if(!p)exit;print "Date,Close";next}$p+0>0{print substr($1,1,10)","$p}' > uni/$a.csv; done

node research/strategy/portfolio.mjs uni 2020-01-01          # modern era
VOL_CAP=0.30 node research/strategy/portfolio.mjs uni        # lower drawdown (risk dial)
COST=0.003 node research/strategy/portfolio.mjs uni 2020-01-01   # stress costs
```

Env: `VOL_CAP` (portfolio vol target, the risk dial; 0=off), `BTC_GATE` (1=on),
`SIG_TGT` (per-sleeve vol 0.20), `CAP` (max/name 0.35), `REBAL` (days, 5), `COST`.
A `btc.csv` must be in the directory (for the BTC-beta gate).

## Get data (any `Date,Close` daily CSV)

```bash
# CoinMetrics community daily closes (PriceUSD column):
curl -sL https://raw.githubusercontent.com/coinmetrics/data/master/csv/btc.csv \
 | awk -F, 'NR==1{for(i=1;i<=NF;i++)if($i=="PriceUSD")p=i;print "Date,Close";next}$p>0{print substr($1,1,10)","$p}' > btc.csv
# ...or your own venue (Binance) for SOL/BTC:
node ../session-direction/fetch-hourly.js SOLUSDT 1d 2020-01-01     # -> SOLUSDT-1d.csv
```

## Run

```bash
node backtest.mjs btc.csv                        # full strategy table
node backtest.mjs btc.csv 2010-01-01 2019-12-31  # train window
node backtest.mjs btc.csv 2020-01-01 2026-12-31  # test window
node compare.mjs btc.csv eth.csv                 # flagship single-asset vs 50/50 portfolio
COST=0.002 node backtest.mjs btc.csv             # stress higher costs
```

## The flagship, in one paragraph

Four causal trend votes on daily closes — above 200-day SMA · 20-day SMA > 100-day SMA ·
Donchian 50-high on / 25-low off · close > close 100 days ago — averaged into a base
weight, then multiplied by a volatility cap `min(1, 0.65 / annualisedVol)` (30-day
vol × √365). Target exposure = base × volScale, clipped to [0,1], rebalanced daily,
long/flat, no leverage. Run per-asset; equal-weight 2+ assets to cut drawdown further.

Zero dependencies (Node ≥ 18). No network at run time — reads a local CSV.
