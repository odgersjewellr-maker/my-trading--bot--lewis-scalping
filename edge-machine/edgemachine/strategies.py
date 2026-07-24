"""Concrete edge strategies — the first real candidate from the backlog.

A "strategy" here is a function ``(price, **params) -> position`` returning a
target position in [-1, 1], decided causally. For non-directional edges the P&L
comes from a separate ``asset_return`` stream (see ``vectorized_backtest`` /
``run_gauntlet``), not from price.

Backlog #1 — funding carry — is implemented here, together with a realistic
synthetic funding generator used only when live exchange data is unreachable.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


# --------------------------------------------------------------------------- #
# Backlog #1: perpetual funding carry (delta-neutral)                          #
# --------------------------------------------------------------------------- #
def funding_carry_position(
    funding: pd.Series, entry_bps: float = 1.0, smooth: int = 3
) -> pd.Series:
    """Delta-neutral funding-carry signal.

    A +1 position = long spot / short perp (collect positive funding); -1 =
    the mirror (collect negative funding). We only take the trade when *smoothed*
    funding is decisively away from zero, so tiny funding that costs more to
    harvest than it pays doesn't trigger churn.

    Parameters
    ----------
    funding:
        Funding rate per settlement interval, as a fraction (1 bp = 1e-4).
    entry_bps:
        Threshold in basis points; only trade when |smoothed funding| > this.
    smooth:
        Rolling window (in intervals) used to smooth the funding signal.

    Returns a position Series in {-1, 0, +1}, decided causally (uses only funding
    known up to and including each bar).
    """
    thr = entry_bps * 1e-4
    sig = funding.rolling(smooth).mean()
    pos = pd.Series(0.0, index=funding.index)
    pos[sig > thr] = 1.0
    pos[sig < -thr] = -1.0
    return pos


def carry_strategy_factory(funding: pd.Series):
    """Adapt funding carry to the ``strategy_fn(price, **params)`` interface.

    The gauntlet calls the returned function with different price slices; we
    reindex the (full) funding series onto whatever index it passes, so the same
    closure works for research, holdout, and full-series calls.
    """
    def strategy_fn(price: pd.Series, entry_bps: float = 1.0, smooth: int = 3) -> pd.Series:
        f = funding.reindex(price.index)
        return funding_carry_position(f, entry_bps=entry_bps, smooth=smooth)
    return strategy_fn


# --------------------------------------------------------------------------- #
# Realistic synthetic funding (offline fallback only)                          #
# --------------------------------------------------------------------------- #
def generate_synthetic_funding(
    n: int = 2400, timeframe_hours: int = 8, seed: int = 11
) -> tuple[pd.Series, pd.Series]:
    """Deterministic, *realistic-shaped* funding + spot price for offline dev.

    Funding is an Ornstein-Uhlenbeck process mean-reverting to a small positive
    level (bull-market default), wandering negative in bear stretches, with
    occasional spikes — the qualitative shape of real perp funding. Returns
    ``(funding, spot_price)``.

    This is for validating the *machinery*, NOT evidence of a real edge — real
    funding must come from a live venue (see examples/fetch_funding.py).
    """
    rng = np.random.default_rng(seed)
    idx = pd.date_range(
        end=pd.Timestamp.utcnow().floor("h"),
        periods=n, freq=f"{timeframe_hours}h",
    )

    # OU funding around a slowly drifting regime mean (bull ~ +1bp, bear ~ -0.3bp)
    theta = 0.00008 + 0.00012 * np.sin(np.linspace(0, 6 * np.pi, n))  # regime cycle
    kappa, sigma = 0.06, 0.00012
    f = np.zeros(n)
    f[0] = theta[0]
    for t in range(1, n):
        f[t] = f[t - 1] + kappa * (theta[t] - f[t - 1]) + rng.normal(0, sigma)
    # occasional funding spikes (squeezes)
    spikes = rng.random(n) < 0.01
    f += spikes * rng.normal(0, 0.0006, n)
    funding = pd.Series(f, index=idx, name="funding")

    # a loosely-correlated spot price (only used for regime classification)
    ret = 0.15 * (funding.values / funding.std()) * 0.01 + rng.normal(0, 0.02, n)
    spot = pd.Series(30000 * np.exp(np.cumsum(ret)), index=idx, name="spot")
    return funding, spot
