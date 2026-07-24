"""Run a parameter grid through the full Validation Gauntlet.

Demonstrates the machine's core defense: take a plausible-looking mean-reversion
strategy, grid-search 25 variants, and let the gauntlet decide. On trendless
synthetic data there is no real edge, so the honest verdict is REJECT — even
though the naive in-sample best will look tempting. That contrast (pretty
in-sample Sharpe -> gauntlet rejects) is the entire point.

Run:  python examples/demo_gauntlet.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import pandas as pd

from config import DEFAULT as CFG
from edgemachine import CostModel, DataStore, ResearchJournal
from edgemachine.gauntlet import run_gauntlet


def zscore_meanrev(price: pd.Series, lookback: int, entry_z: float) -> pd.Series:
    """Buy when price is `entry_z` std below its mean, sell when above. Causal."""
    ma = price.rolling(lookback).mean()
    sd = price.rolling(lookback).std()
    z = (price - ma) / sd
    pos = pd.Series(0.0, index=price.index)
    pos[z < -entry_z] = 1.0
    pos[z > entry_z] = -1.0
    return pos


def main() -> None:
    print("=" * 68)
    print("EDGE MACHINE — Validation Gauntlet (z-score mean reversion)")
    print("=" * 68)

    store = DataStore(CFG.data.root)
    price = store.fetch(
        exchange=CFG.data.exchange, symbol=CFG.data.symbol,
        timeframe=CFG.data.timeframe, limit=CFG.data.limit, source=CFG.data.source,
    )["close"]

    grid = {
        "lookback": [10, 20, 30, 40, 50],
        "entry_z": [0.5, 1.0, 1.5, 2.0, 2.5],
    }
    print(f"\ndata   : {len(price)} bars {CFG.data.symbol} {CFG.data.timeframe}")
    print(f"grid   : {len(grid['lookback']) * len(grid['entry_z'])} variants "
          f"(lookback x entry_z)\n")

    costs = CostModel(
        taker_fee_bps=CFG.cost.taker_fee_bps,
        half_spread_bps=CFG.cost.half_spread_bps,
    )
    with ResearchJournal(CFG.journal_path) as jrn:
        result = run_gauntlet(
            price, zscore_meanrev, grid, cost_model=costs,
            periods_per_year=CFG.backtest.periods_per_year,
            holdout_frac=CFG.backtest.holdout_frac,
            journal=jrn, name="zscore_meanrev",
            market=f"{CFG.data.exchange}:{CFG.data.symbol}",
            hypothesis="Short-term overreactions mean-revert.",
            mechanism="DEMO — synthetic GBM has no reversion; expect REJECT.",
        )

    print(result.summary_text())
    print("\n" + "-" * 68)
    print("Note how many checks fail even though a 25-variant grid always yields")
    print("SOME nice in-sample Sharpe. That gap is exactly what the gauntlet exists")
    print("to catch. Logged to the journal with verdict + n_trials for the record.")
    print("-" * 68)


if __name__ == "__main__":
    main()
