"""Phase 3 — correlation-aware portfolio allocation across edges.

The thesis of the whole machine: uncorrelated edges combine to a higher Sharpe
than any of them alone. Three uncorrelated edges at Sharpe 0.5 combine to ~0.87;
the same three at 0.8 correlation give ~0.53. So the allocator's real job is to
*manufacture low correlation* — reward edges that pay off at different times and
penalize redundant ones.

Allocators (all long-only, weights sum to 1):
  inverse_variance_weights   size by 1/variance; ignores correlation (baseline)
  min_variance_weights       w ∝ Σ⁻¹1; correlation-aware, can concentrate
  risk_parity_weights        equal risk contribution; correlation-aware + diversified

Dependencies: numpy, pandas only.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import metrics


# --------------------------------------------------------------------------- #
# Allocators                                                                   #
# --------------------------------------------------------------------------- #
def inverse_variance_weights(returns: pd.DataFrame) -> pd.Series:
    """Weight ∝ 1/variance. Naive risk weighting — blind to correlation."""
    v = returns.var(ddof=1)
    w = 1.0 / v.replace(0, np.nan)
    w = w.fillna(0.0)
    return w / w.sum()


def min_variance_weights(returns: pd.DataFrame, ridge: float = 1e-6) -> pd.Series:
    """Long-only minimum-variance: w ∝ Σ⁻¹1, clipped ≥ 0 and renormalized.

    Correlation-aware — it naturally down-weights (or drops) redundant edges, but
    can concentrate into a few names.
    """
    cov = returns.cov().to_numpy()
    n = cov.shape[0]
    cov = cov + ridge * np.trace(cov) / n * np.eye(n)   # ridge for stability
    inv = np.linalg.pinv(cov)
    w = inv @ np.ones(n)
    w = np.clip(w, 0.0, None)
    if w.sum() == 0:
        w = np.ones(n)
    return pd.Series(w / w.sum(), index=returns.columns)


def risk_parity_weights(returns: pd.DataFrame, iters: int = 1000,
                        tol: float = 1e-9) -> pd.Series:
    """Equal Risk Contribution via cyclical coordinate descent (Roncalli).

    Each edge contributes the same share of portfolio risk — the most diversified
    of the three, and the natural default for combining edges you believe in
    roughly equally.
    """
    cov = returns.cov().to_numpy()
    n = cov.shape[0]
    b = np.ones(n) / n
    w = np.ones(n) / n
    # Cyclical coordinate descent: each update solves wᵢ·(Σw)ᵢ = bᵢ. Do NOT
    # renormalize inside the loop — that shifts the fixed point; normalize once
    # at the end (risk-contribution equality is scale-invariant).
    for _ in range(iters):
        w_old = w.copy()
        for i in range(n):
            c = w @ cov[i] - cov[i, i] * w[i]           # risk from the other legs
            w[i] = (-c + np.sqrt(c * c + 4 * cov[i, i] * b[i])) / (2 * cov[i, i])
        if np.abs(w - w_old).max() < tol:
            break
    return pd.Series(w / w.sum(), index=returns.columns)


_ALLOCATORS = {
    "inverse_variance": inverse_variance_weights,
    "min_variance": min_variance_weights,
    "risk_parity": risk_parity_weights,
}


# --------------------------------------------------------------------------- #
# Portfolio                                                                    #
# --------------------------------------------------------------------------- #
@dataclass
class Portfolio:
    returns: pd.DataFrame       # per-bar returns, one column per edge (aligned)
    weights: pd.Series
    periods_per_year: int
    method: str = ""

    @property
    def portfolio_returns(self) -> pd.Series:
        return (self.returns * self.weights).sum(axis=1)

    @property
    def correlation(self) -> pd.DataFrame:
        return self.returns.corr()

    def risk_contributions(self) -> pd.Series:
        cov = self.returns.cov().to_numpy()
        w = self.weights.to_numpy()
        port_var = float(w @ cov @ w)
        rc = w * (cov @ w) / port_var if port_var > 0 else w * 0
        return pd.Series(rc, index=self.weights.index)

    def diversification_ratio(self) -> float:
        """(weighted avg vol) / (portfolio vol). >1; higher = more diversification."""
        sig = self.returns.std(ddof=1).to_numpy()
        w = self.weights.to_numpy()
        port_vol = self.portfolio_returns.std(ddof=1)
        return float((w @ sig) / port_vol) if port_vol > 0 else 1.0

    def effective_bets(self) -> float:
        """1 / Σ wᵢ² — the effective number of independent positions."""
        w = self.weights.to_numpy()
        return float(1.0 / np.sum(w ** 2)) if np.sum(w ** 2) > 0 else 0.0

    def sharpe(self) -> float:
        return metrics.sharpe(self.portfolio_returns, self.periods_per_year)

    def report(self) -> str:
        indiv = {c: metrics.sharpe(self.returns[c], self.periods_per_year)
                 for c in self.returns.columns}
        wavg = float(sum(self.weights[c] * indiv[c] for c in self.returns.columns))
        rc = self.risk_contributions()
        lines = [f"PORTFOLIO ({self.method})",
                 "  edge                weight   Sharpe   risk-contrib"]
        for c in self.returns.columns:
            lines.append(f"  {c:<18} {self.weights[c]:6.1%}   {indiv[c]:6.2f}   {rc[c]:6.1%}")
        lines += [
            "  " + "-" * 50,
            f"  weighted-avg edge Sharpe : {wavg:6.2f}",
            f"  PORTFOLIO Sharpe         : {self.sharpe():6.2f}   "
            f"(+{self.sharpe()-wavg:.2f} from diversification)",
            f"  diversification ratio    : {self.diversification_ratio():6.2f}",
            f"  effective # of bets      : {self.effective_bets():6.2f}  of {len(self.weights)}",
        ]
        return "\n".join(lines)


def build_portfolio(returns: pd.DataFrame, method: str = "risk_parity",
                    periods_per_year: int = 365, journal=None,
                    name: str = "portfolio") -> Portfolio:
    """Allocate across edge return streams and (optionally) log the allocation.

    ``returns`` columns are edges, rows are aligned per-bar returns.
    """
    if method not in _ALLOCATORS:
        raise ValueError(f"method must be one of {list(_ALLOCATORS)}")
    returns = returns.dropna(how="any")
    weights = _ALLOCATORS[method](returns)
    port = Portfolio(returns, weights, periods_per_year, method)
    if journal is not None:
        journal.log(
            name=name, market="crypto", hypothesis="Combine validated edges.",
            mechanism="Diversification across uncorrelated edges raises Sharpe.",
            params={"method": method, **{f"w_{c}": round(float(weights[c]), 4)
                                          for c in returns.columns}},
            n_trials=len(returns.columns), sharpe=port.sharpe(),
            stage="portfolio", verdict="hold",
            notes=f"div_ratio={port.diversification_ratio():.2f} "
                  f"eff_bets={port.effective_bets():.2f}",
        )
    return port
