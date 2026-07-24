"""Performance metrics.

Everything operates on a *per-bar strategy return* Series (net or gross).
Keep these dependency-light and correct; the whole machine trusts them.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def equity_curve(returns: pd.Series) -> pd.Series:
    """Compound per-bar returns into an equity curve starting at 1.0."""
    return (1.0 + returns.fillna(0.0)).cumprod()


def sharpe(returns: pd.Series, periods_per_year: int = 365) -> float:
    """Annualized Sharpe ratio (risk-free assumed 0 — fine for crypto/relative work)."""
    r = returns.dropna()
    sd = r.std(ddof=1)
    if sd == 0 or len(r) < 2:
        return 0.0
    return float(r.mean() / sd * np.sqrt(periods_per_year))


def sortino(returns: pd.Series, periods_per_year: int = 365) -> float:
    """Annualized Sortino ratio (downside deviation only)."""
    r = returns.dropna()
    downside = r[r < 0]
    dd = downside.std(ddof=1)
    if dd == 0 or len(r) < 2:
        return 0.0
    return float(r.mean() / dd * np.sqrt(periods_per_year))


def max_drawdown(returns: pd.Series) -> float:
    """Maximum peak-to-trough drawdown of the equity curve (negative number)."""
    eq = equity_curve(returns)
    peak = eq.cummax()
    dd = eq / peak - 1.0
    return float(dd.min())


def cagr(returns: pd.Series, periods_per_year: int = 365) -> float:
    """Compound annual growth rate implied by the return series."""
    r = returns.dropna()
    if len(r) == 0:
        return 0.0
    total = (1.0 + r).prod()
    years = len(r) / periods_per_year
    if years <= 0 or total <= 0:
        return 0.0
    return float(total ** (1.0 / years) - 1.0)


def hit_rate(returns: pd.Series) -> float:
    """Fraction of non-zero bars that were positive."""
    r = returns[returns != 0].dropna()
    if len(r) == 0:
        return 0.0
    return float((r > 0).mean())


def summary(returns: pd.Series, periods_per_year: int = 365) -> dict:
    """A compact dict of the headline metrics."""
    r = returns.dropna()
    return {
        "n_bars": int(len(r)),
        "total_return": float((1.0 + r).prod() - 1.0),
        "cagr": cagr(r, periods_per_year),
        "sharpe": sharpe(r, periods_per_year),
        "sortino": sortino(r, periods_per_year),
        "max_drawdown": max_drawdown(r),
        "hit_rate": hit_rate(r),
        "vol_annualized": float(r.std(ddof=1) * np.sqrt(periods_per_year)) if len(r) > 1 else 0.0,
    }
