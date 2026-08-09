"""
entry_screener.py — reports which tickers are currently in SimpleTrendFilter's
one and only preferred entry state: daily close above its 150-day SMA.

This does not predict anything or rank tickers by "quality" beyond that one
rule - it exists to answer "which of my candidate assets currently qualify"
so a portfolio (see config-multi-asset.json) can be extended without hand
-checking charts. Screening more tickers raises trade frequency, the way
BTC+ETH did over BTC alone - it does not raise the edge per trade. See the
README's "actual frequency win" section for why that distinction matters.

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
DATA_DIR = Path(__file__).resolve().parent.parent / "user_data" / "data" / "binance"


def screen_pair(feather_path: Path) -> dict | None:
    df = pd.read_feather(feather_path)
    df = df.sort_values("date").reset_index(drop=True)
    df["sma"] = df["close"].rolling(SMA_PERIOD).mean()

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

    pair = feather_path.stem.replace("-1d", "").replace("_", "/")
    return {
        "pair": pair,
        "as_of": last["date"],
        "close": last["close"],
        "sma150": last["sma"],
        "pct_from_sma": pct_from_sma,
        "bullish": bool(bullish.iloc[-1]),
        "days_since_flip": days_since_flip,
    }


def classify(result: dict, watch_band: float) -> str:
    if result["bullish"]:
        if result["days_since_flip"] is not None and result["days_since_flip"] <= 14:
            return "FRESH SIGNAL (just entered preferred state)"
        return "IN TREND (preferred state, already established)"
    if result["pct_from_sma"] >= -watch_band:
        return f"APPROACHING (within {watch_band:.0f}% of preferred state)"
    return "NOT IN PREFERRED STATE"


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

    rows = []
    for f in files:
        result = screen_pair(f)
        if result:
            rows.append(result)

    rows.sort(key=lambda r: (not r["bullish"], -r["pct_from_sma"]))

    print(f"{'Pair':<10} {'As of':<12} {'Close':>12} {'SMA150':>12} {'% vs SMA':>10}  State")
    print("-" * 90)
    for r in rows:
        state = classify(r, args.watch_band)
        print(
            f"{r['pair']:<10} {str(r['as_of'].date()):<12} {r['close']:>12,.2f} "
            f"{r['sma150']:>12,.2f} {r['pct_from_sma']:>+9.2f}%  {state}"
        )


if __name__ == "__main__":
    main()
