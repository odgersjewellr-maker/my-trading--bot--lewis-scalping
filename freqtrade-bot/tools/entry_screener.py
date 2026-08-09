"""
entry_screener.py — reports which tickers are currently in SimpleTrendFilter's
one and only preferred entry state: daily close above its 150-day SMA. Also
reports volatility, momentum, volume-trend, and BTC-correlation as
diagnostic context.

IMPORTANT BOUNDARY: the "State" column is the only thing SimpleTrendFilter
actually trades on. Every other column (volatility, momentum, volume trend,
correlation) is diagnostic context for deciding whether a candidate is worth
*backtesting* before adding it to the portfolio - not a new filter baked
into the strategy. Every attempt this session to add extra conditions
directly into the trading rule (Donchian breakout, pyramiding) made
performance worse, which is why they stay separate here: look at these
columns, form a hypothesis, then go validate it with a real backtest the
same way SimpleTrendFilter itself was validated. Do not wire these into an
automatic ranking/selection rule without doing that.

Why these four, specifically:
- Volatility (30d annualized realized vol): position-sizing context - a
  high-vol asset needs a smaller position for the same dollar risk.
- Momentum (90d/180d % change): a proxy for trend strength, useful for
  judging whether "in trend" is a strong move or a weak drift.
- Volume trend (30d avg vs. prior 30d avg): rising interest/liquidity vs.
  fading - useful for judging whether a breakout candidate has real
  participation, the same idea TrendFollowingStarter used.
- BTC correlation (90d rolling, daily returns): the direct lesson from
  adding ETH to the portfolio - a high-correlation, weaker-performing
  addition dilutes the better asset instead of diversifying it. Low
  correlation is what makes a second asset additive rather than diluting.

Usage:
    python3 tools/entry_screener.py                    # scan bundled data
    python3 tools/entry_screener.py --watch-band 5      # widen the "approaching" band to 5%

Reads every `*-1d.feather` file in user_data/data/binance/. To screen a
ticker not already bundled, pull its daily history first (on a machine with
real exchange access):
    freqtrade download-data --userdir user_data -p SOL/USDT -t 1d --timerange 20170101-
"""

import argparse
from pathlib import Path

import pandas as pd

SMA_PERIOD = 150
MOMENTUM_WINDOWS = (90, 180)
VOL_WINDOW = 30
VOLUME_TREND_WINDOW = 30
CORRELATION_WINDOW = 90
BENCHMARK_PAIR = "BTC/USDT"
DATA_DIR = Path(__file__).resolve().parent.parent / "user_data" / "data" / "binance"


def load_pair(feather_path: Path) -> pd.DataFrame:
    df = pd.read_feather(feather_path)
    df = df.sort_values("date").reset_index(drop=True)
    df["sma"] = df["close"].rolling(SMA_PERIOD).mean()
    df["daily_return"] = df["close"].pct_change()
    return df


def screen_pair(feather_path: Path, benchmark_returns: pd.Series | None) -> dict | None:
    df = load_pair(feather_path)
    if df["sma"].isna().all():
        return None

    valid = df.dropna(subset=["sma"]).reset_index(drop=True)
    last = valid.iloc[-1]

    bullish = valid["close"] > valid["sma"]
    flips = bullish.ne(bullish.shift())
    flip_idxs = valid.index[flips]
    last_flip_idx = flip_idxs.max() if len(flip_idxs) else None
    days_since_flip = (
        (last["date"] - valid.loc[last_flip_idx, "date"]).days
        if last_flip_idx is not None
        else None
    )

    pct_from_sma = (last["close"] - last["sma"]) / last["sma"] * 100

    vol_30d = df["daily_return"].rolling(VOL_WINDOW).std().iloc[-1]
    vol_annualized_pct = vol_30d * (365**0.5) * 100 if pd.notna(vol_30d) else None

    momentum = {}
    for w in MOMENTUM_WINDOWS:
        if len(df) > w:
            momentum[w] = (df["close"].iloc[-1] / df["close"].iloc[-1 - w] - 1) * 100
        else:
            momentum[w] = None

    vol_avg = df["volume"].rolling(VOLUME_TREND_WINDOW).mean()
    vol_avg_prior = vol_avg.shift(VOLUME_TREND_WINDOW)
    if pd.notna(vol_avg.iloc[-1]) and pd.notna(vol_avg_prior.iloc[-1]) and vol_avg_prior.iloc[-1] > 0:
        volume_trend_pct = (vol_avg.iloc[-1] - vol_avg_prior.iloc[-1]) / vol_avg_prior.iloc[-1] * 100
    else:
        volume_trend_pct = None

    corr_to_btc = None
    pair = feather_path.stem.replace("-1d", "").replace("_", "/")
    if benchmark_returns is not None and pair != BENCHMARK_PAIR:
        aligned = pd.concat(
            [df.set_index("date")["daily_return"], benchmark_returns], axis=1, join="inner"
        ).tail(CORRELATION_WINDOW)
        if len(aligned) >= CORRELATION_WINDOW // 2:
            corr_to_btc = aligned.iloc[:, 0].corr(aligned.iloc[:, 1])

    return {
        "pair": pair,
        "as_of": last["date"],
        "close": last["close"],
        "sma150": last["sma"],
        "pct_from_sma": pct_from_sma,
        "bullish": bool(bullish.iloc[-1]),
        "days_since_flip": days_since_flip,
        "vol_annualized_pct": vol_annualized_pct,
        "momentum_90d": momentum.get(90),
        "momentum_180d": momentum.get(180),
        "volume_trend_pct": volume_trend_pct,
        "corr_to_btc": corr_to_btc,
    }


def classify(result: dict, watch_band: float) -> str:
    if result["bullish"]:
        if result["days_since_flip"] is not None and result["days_since_flip"] <= 14:
            return "FRESH SIGNAL"
        return "IN TREND"
    if result["pct_from_sma"] >= -watch_band:
        return f"APPROACHING (<{watch_band:.0f}%)"
    return "NOT IN STATE"


def fmt_pct(value, decimals=1) -> str:
    return f"{value:+.{decimals}f}%" if value is not None else "n/a"


def fmt_corr(value) -> str:
    return f"{value:+.2f}" if value is not None else "n/a"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--watch-band",
        type=float,
        default=3.0,
        help="Flag tickers within this %% below the SMA as 'approaching' (default 3%%).",
    )
    args = parser.parse_args()

    files = sorted(DATA_DIR.glob("*-1d.feather"))
    if not files:
        print(f"No *-1d.feather files found in {DATA_DIR}")
        return

    benchmark_returns = None
    benchmark_file = DATA_DIR / f"{BENCHMARK_PAIR.replace('/', '_')}-1d.feather"
    if benchmark_file.exists():
        bdf = load_pair(benchmark_file)
        benchmark_returns = bdf.set_index("date")["daily_return"].rename("btc_return")

    rows = []
    for f in files:
        result = screen_pair(f, benchmark_returns)
        if result:
            rows.append(result)

    rows.sort(key=lambda r: (not r["bullish"], -r["pct_from_sma"]))

    print(
        f"{'Pair':<10} {'As of':<12} {'% vs SMA':>9}  {'State':<16} "
        f"{'Vol(ann)':>9} {'Mom90d':>8} {'Mom180d':>9} {'VolTrend':>9} {'BTCCorr':>8}"
    )
    print("-" * 100)
    for r in rows:
        state = classify(r, args.watch_band)
        print(
            f"{r['pair']:<10} {str(r['as_of'].date()):<12} {r['pct_from_sma']:>+8.2f}%  {state:<16} "
            f"{fmt_pct(r['vol_annualized_pct'], 0):>9} {fmt_pct(r['momentum_90d']):>8} "
            f"{fmt_pct(r['momentum_180d']):>9} {fmt_pct(r['volume_trend_pct']):>9} "
            f"{fmt_corr(r['corr_to_btc']):>8}"
        )

    print()
    print(
        "State is the only column SimpleTrendFilter trades on. The rest is context for deciding\n"
        "what to backtest next, not inputs to an automatic decision - see the module docstring."
    )


if __name__ == "__main__":
    main()
