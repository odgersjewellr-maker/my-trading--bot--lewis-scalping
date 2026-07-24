"""Transaction-cost model.

Rule of the machine: costs are applied BEFORE you get excited about a backtest.
A 55%-win edge dies instantly if round-trip cost eats the margin, so we model
fees, spread, and (optionally) market impact explicitly.

Costs are expressed in basis points (1 bps = 0.01%) and charged against
*turnover* — the absolute change in position each bar.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

BPS = 1e-4


@dataclass(frozen=True)
class CostModel:
    """A per-turnover cost in basis points.

    Attributes
    ----------
    taker_fee_bps:
        Exchange fee per side (e.g. Binance spot taker ~= 5-10 bps).
    half_spread_bps:
        Cost of crossing half the bid/ask spread per trade.
    impact_coef_bps:
        Coefficient on a square-root market-impact term. Cost contribution is
        ``impact_coef_bps * sqrt(participation)`` where ``participation`` is the
        fraction of bar volume you consume. Leave at 0 until you model size.
    """

    taker_fee_bps: float = 5.0
    half_spread_bps: float = 2.0
    impact_coef_bps: float = 0.0

    def rate_per_turnover(self) -> float:
        """Fixed cost fraction charged per unit of turnover (fee + spread)."""
        return (self.taker_fee_bps + self.half_spread_bps) * BPS

    def apply(self, turnover: pd.Series, participation: pd.Series | None = None) -> pd.Series:
        """Return the per-bar cost (as a return drag) for a turnover series.

        ``turnover`` is ``|position.diff()|``. Optional ``participation`` (0..1)
        adds a sqrt-impact term for capacity/size stress tests.
        """
        cost = turnover.abs() * self.rate_per_turnover()
        if participation is not None and self.impact_coef_bps > 0:
            impact = self.impact_coef_bps * BPS * np.sqrt(participation.clip(lower=0.0))
            cost = cost + turnover.abs() * impact
        return cost

    def stressed(self, factor: float = 2.0) -> "CostModel":
        """Return a copy with fee + spread scaled — for the gauntlet's 2x-cost test."""
        return CostModel(
            taker_fee_bps=self.taker_fee_bps * factor,
            half_spread_bps=self.half_spread_bps * factor,
            impact_coef_bps=self.impact_coef_bps * factor,
        )
