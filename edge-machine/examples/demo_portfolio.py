"""Phase 3 — correlation-aware portfolio allocation.

Two demonstrations:
  A) The combination math: N *uncorrelated* edges each at Sharpe ~1 combine to a
     portfolio Sharpe of ~sqrt(N). Correlation is the whole game.
  B) Allocation across 4 edges where two are redundant (highly correlated). The
     correlation-aware allocators down-weight the redundant pair; naive
     inverse-variance does not — and the portfolio Sharpe reflects it.

Run:  python examples/demo_portfolio.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import pandas as pd

from edgemachine import metrics
from edgemachine.portfolio import build_portfolio

PPY = 365
N = 1500
IDX = pd.date_range("2021-01-01", periods=N, freq="D")


def make_edge(ann_sharpe, rng, base_z=None, rho=0.0, sd=0.01):
    """Return a per-bar return stream with a target annualized Sharpe."""
    z = rng.normal(0, 1, N)
    if base_z is not None:
        z = rho * base_z + np.sqrt(1 - rho ** 2) * z     # correlate with base
    mu = (ann_sharpe / np.sqrt(PPY)) * sd
    return mu + sd * z, z


def combination_math(trials: int = 300):
    print("A) Combination math — N uncorrelated edges, each Sharpe ~1.0, equal weight")
    print(f"   (mean over {trials} Monte-Carlo trials)")
    print("   k   portfolio Sharpe   sqrt(k)")
    rng = np.random.default_rng(0)
    sd = 0.01
    mu = (1.0 / np.sqrt(PPY)) * sd
    for k in range(1, 6):
        sharpes = []
        for _ in range(trials):
            legs = mu + sd * rng.normal(0, 1, (k, N))    # k independent edges
            port = legs.mean(axis=0)                       # equal weight
            s = port.std(ddof=1)
            sharpes.append(port.mean() / s * np.sqrt(PPY) if s > 0 else 0.0)
        print(f"   {k}       {np.mean(sharpes):5.2f}           {np.sqrt(k):.2f}")
    print("   -> uncorrelated edges stack ~sqrt(N); that's the diversification engine.\n")


def allocation_demo():
    print("B) Allocation with a redundant (correlated) pair")
    rng = np.random.default_rng(7)
    a, za = make_edge(1.0, rng)                    # edge A
    b, _ = make_edge(1.0, rng)                     # edge B (independent)
    c, _ = make_edge(1.0, rng, base_z=za, rho=0.85)  # edge C ~ redundant with A
    d, _ = make_edge(1.0, rng)                     # edge D (independent)
    df = pd.DataFrame({"A_momentum": a, "B_carry": b,
                       "C_dup_of_A": c, "D_reversal": d}, index=IDX)

    print("\n  correlation matrix:")
    corr = df.corr()
    print(corr.round(2).to_string().replace("\n", "\n  "))

    print()
    for method in ("inverse_variance", "min_variance", "risk_parity"):
        port = build_portfolio(df, method=method, periods_per_year=PPY)
        print(port.report())
        print()

    print("  Note: inverse-variance splits ~evenly (blind to the A/C overlap), so the")
    print("  redundant pair double-counts. min-variance and risk-parity both cut the")
    print("  A/C weights and lift the portfolio Sharpe — correlation-awareness paying off.")


def main() -> None:
    print("=" * 72)
    print("EDGE MACHINE — Phase 3: correlation-aware portfolio allocation")
    print("=" * 72 + "\n")
    combination_math()
    allocation_demo()


if __name__ == "__main__":
    main()
