"""Capstone — exercise the whole machine and print its health dashboard.

Runs the full loop end to end:
  backlog -> gauntlet (one real-ish pass, one reject) -> portfolio -> KPIs

so the improvement-cadence dashboard shows real numbers. Uses a throwaway
journal under data/ (gitignored).

Run:  python examples/machine_status.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import pandas as pd

from edgemachine import CostModel, ResearchJournal, build_portfolio, render_kpis
from edgemachine import backlog as bl
from edgemachine.gauntlet import run_gauntlet

JOURNAL = "data/machine_status.db"


def mean_rev_series(n, seed, phi):
    rng = np.random.default_rng(seed)
    x = np.zeros(n)
    for t in range(1, n):
        x[t] = phi * x[t - 1] + rng.normal(0, 0.02)
    return pd.Series(100 * np.exp(x), index=pd.date_range("2016-01-01", periods=n, freq="D"))


def zscore_mr(p, lookback, entry_z):
    ma = p.rolling(lookback).mean(); sd = p.rolling(lookback).std(); z = (p - ma) / sd
    pos = pd.Series(0.0, index=p.index); pos[z < -entry_z] = 1.0; pos[z > entry_z] = -1.0
    return pos


def main() -> None:
    Path(JOURNAL).unlink(missing_ok=True)
    print("=" * 66)
    print("EDGE MACHINE — full-loop status")
    print("=" * 66)
    grid = {"lookback": [10, 20, 30, 40, 50], "entry_z": [0.5, 1.0, 1.5, 2.0, 2.5]}
    costs = CostModel(5, 2)

    with ResearchJournal(JOURNAL) as jrn:
        # 1) seed the backlog
        bl.seed_journal(jrn)

        # 2) gauntlet: a genuinely mean-reverting series (should PASS) ...
        r1 = run_gauntlet(mean_rev_series(3000, 7, phi=0.92), zscore_mr, grid,
                          cost_model=costs, journal=jrn, name="meanrev_strong")
        # ... and a near-random one (should REJECT)
        r2 = run_gauntlet(mean_rev_series(3000, 3, phi=0.999), zscore_mr, grid,
                          cost_model=costs, journal=jrn, name="meanrev_weak")
        print(f"\ngauntlet: meanrev_strong -> {'PASS' if r1.passed else 'REJECT'}, "
              f"meanrev_weak -> {'PASS' if r2.passed else 'REJECT'}")

        # 3) portfolio across two toy edge streams
        idx = pd.date_range("2021-01-01", periods=1500, freq="D")
        rng = np.random.default_rng(0)
        edges = pd.DataFrame({
            "meanrev": 0.0005 + 0.01 * rng.normal(0, 1, 1500),
            "carry": 0.0005 + 0.01 * rng.normal(0, 1, 1500),
        }, index=idx)
        build_portfolio(edges, method="risk_parity", journal=jrn, name="live_book")

        df = jrn.to_df()

    print("\n" + render_kpis(df))
    print("\n(Next in a real loop: promote passes to paper via run_paper, watch them")
    print(" with LiveMonitor, retire decayed edges, and feed post-mortems back to the")
    print(" backlog — the continual-improvement cadence.)")


if __name__ == "__main__":
    main()
