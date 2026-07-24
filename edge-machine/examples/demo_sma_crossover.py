"""End-to-end Phase 0 deliverable.

Reproduces a *known, simple* strategy (SMA crossover) through the entire
pipeline — data -> signal -> cost-aware backtest -> journal — so you can trust
the plumbing before you hunt for real edges.

The point of this demo is NOT that SMA crossover is an edge (it almost
certainly isn't, net of costs — which is exactly what the output shows you).
The point is that every component connects and that costs are visible.

Run:  python examples/demo_sma_crossover.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Make the package importable when run as a plain script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pandas as pd

from config import DEFAULT as CFG
from edgemachine import CostModel, DataStore, ResearchJournal, vectorized_backtest


def sma_crossover_position(close: pd.Series, fast: int, slow: int) -> pd.Series:
    """+1 when fast SMA > slow SMA, else 0 (long/flat). Decided at each close."""
    fast_ma = close.rolling(fast).mean()
    slow_ma = close.rolling(slow).mean()
    return (fast_ma > slow_ma).astype(float)


def main() -> None:
    print("=" * 66)
    print("EDGE MACHINE — Phase 0 end-to-end smoke test (SMA crossover)")
    print("=" * 66)

    # 1) DATA -----------------------------------------------------------------
    store = DataStore(CFG.data.root)
    df = store.fetch(
        exchange=CFG.data.exchange,
        symbol=CFG.data.symbol,
        timeframe=CFG.data.timeframe,
        limit=CFG.data.limit,
        source=CFG.data.source,
    )
    close = df["close"]
    print(f"\n[1] data     : {len(df)} bars of {CFG.data.symbol} {CFG.data.timeframe} "
          f"({df.index[0].date()} -> {df.index[-1].date()})")

    # 2) SIGNAL ---------------------------------------------------------------
    fast, slow = 20, 50
    position = sma_crossover_position(close, fast, slow)
    print(f"[2] signal   : SMA({fast}) over SMA({slow}), long/flat")

    # 3) COST-AWARE BACKTEST --------------------------------------------------
    costs = CostModel(
        taker_fee_bps=CFG.cost.taker_fee_bps,
        half_spread_bps=CFG.cost.half_spread_bps,
        impact_coef_bps=CFG.cost.impact_coef_bps,
    )
    result = vectorized_backtest(
        close, position, cost_model=costs, periods_per_year=CFG.backtest.periods_per_year
    )
    print(f"[3] backtest : costs = {costs.taker_fee_bps + costs.half_spread_bps:.1f} bps/turn\n")
    print(result.summary_text())

    # 4) JOURNAL --------------------------------------------------------------
    stats = result.stats
    with ResearchJournal(CFG.journal_path) as jrn:
        exp_id = jrn.log(
            name=f"sma_crossover_{fast}_{slow}",
            market=f"{CFG.data.exchange}:{CFG.data.symbol}",
            hypothesis="Trend persistence: price above its trend continues up.",
            mechanism="WEAK — no forced counterparty; classic overfit magnet. Demo only.",
            params={"fast": fast, "slow": slow},
            n_trials=1,
            sharpe=stats["sharpe"],
            max_drawdown=stats["max_drawdown"],
            cagr=stats["cagr"],
            avg_turnover=stats["avg_turnover"],
            cost_drag=stats["cost_drag_annual"],
            stage="backtest",
            verdict="reject" if stats["sharpe"] < 0.5 else "hold",
            notes="Phase 0 plumbing smoke test.",
        )
    print(f"\n[4] journal  : logged experiment #{exp_id} -> {CFG.journal_path}")

    print("\n" + "-" * 66)
    print("Read the 'cost drag/yr' line: that is why a raw signal is not an edge.")
    print("Next: push a mechanism-first idea through the Validation Gauntlet.")
    print("-" * 66)


if __name__ == "__main__":
    main()
