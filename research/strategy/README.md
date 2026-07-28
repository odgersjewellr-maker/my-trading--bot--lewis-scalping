# Trend-ensemble strategy (daily, long/flat)

The best *risk-adjusted* strategy from this research: a daily trend-following ensemble
with a mild volatility cap. Roughly **halves buy-and-hold's drawdown** (−93 % → ~−43 to
−50 %) at a similar or better Sharpe/Calmar, validated on BTC train/test **and** ETH
(out-of-sample asset) with untuned, textbook parameters.

**→ Full write-up & honest caveats: [`docs/research/strategy-trend-crypto.md`](../../docs/research/strategy-trend-crypto.md)**

## Files

| File | What it does |
|---|---|
| `backtest.mjs` | Causal daily long/flat engine + strategy library (buy&hold, SMA200, MA-cross, Donchian, TSMOM, vol-target, ensemble, ensemble+vol-cap). Prints CAGR / MaxDD / Sharpe / Sortino / Calmar / win% / exposure / trades. Costs included. |
| `compare.mjs` | Runs the flagship (`Ensemble+VolCap`) on two assets and a 50/50 portfolio; monthly/yearly win rates; writes `curves.json`. |

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
