"""Vectorized backtester.

Fast enough to scan thousands of parameter variants. Its single most important
job is **look-ahead protection**: the position you decide on bar *t* can only
earn the return realized from *t* to *t+1*. We enforce that with one shift so
you cannot accidentally trade on information you didn't have yet.

For final validation of a survivor you would re-run through an event-driven
engine with realistic fills — but for discovery, this is the workhorse.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from .costs import CostModel
from . import metrics


@dataclass
class BacktestResult:
    returns_net: pd.Series      # per-bar net returns (after costs)
    returns_gross: pd.Series    # per-bar gross returns (before costs)
    position: pd.Series         # position actually held each bar (shifted)
    turnover: pd.Series         # |change in target position| per bar
    equity: pd.Series           # net equity curve, starts at 1.0
    periods_per_year: int

    @property
    def stats(self) -> dict:
        net = metrics.summary(self.returns_net, self.periods_per_year)
        gross = metrics.summary(self.returns_gross, self.periods_per_year)
        net["gross_sharpe"] = gross["sharpe"]
        net["cost_drag_annual"] = gross["cagr"] - net["cagr"]
        net["avg_turnover"] = float(self.turnover.mean())
        return net

    def summary_text(self) -> str:
        s = self.stats
        return (
            f"  bars           : {s['n_bars']}\n"
            f"  total return   : {s['total_return']*100:8.2f}%\n"
            f"  CAGR           : {s['cagr']*100:8.2f}%\n"
            f"  Sharpe (net)   : {s['sharpe']:8.2f}   (gross {s['gross_sharpe']:.2f})\n"
            f"  Sortino        : {s['sortino']:8.2f}\n"
            f"  max drawdown   : {s['max_drawdown']*100:8.2f}%\n"
            f"  hit rate       : {s['hit_rate']*100:8.2f}%\n"
            f"  ann. vol       : {s['vol_annualized']*100:8.2f}%\n"
            f"  avg turnover   : {s['avg_turnover']:8.4f}\n"
            f"  cost drag/yr   : {s['cost_drag_annual']*100:8.2f}%  <-- the reason most edges die"
        )


def vectorized_backtest(
    prices: pd.Series,
    target_position: pd.Series,
    cost_model: CostModel | None = None,
    periods_per_year: int = 365,
    participation: pd.Series | None = None,
) -> BacktestResult:
    """Run a vectorized backtest.

    Parameters
    ----------
    prices:
        Close prices, indexed by time.
    target_position:
        Desired position each bar in units of capital, typically in [-1, 1]
        (1 = fully long, -1 = fully short, 0 = flat). Decided using information
        available *at that bar's close*.
    cost_model:
        Transaction costs. If None, a zero-cost model is used (never trust that
        number — always pass a real one before believing an edge).
    periods_per_year:
        Bars per year for annualization (365 for daily crypto, 8760 for hourly).
    participation:
        Optional per-bar fraction of volume consumed, for impact stress tests.
    """
    cost_model = cost_model or CostModel(0.0, 0.0, 0.0)

    prices = prices.astype(float)
    target = target_position.reindex(prices.index).fillna(0.0)

    market_ret = prices.pct_change(fill_method=None).fillna(0.0)

    # --- look-ahead protection --------------------------------------------
    # The position decided at close of bar t earns the return from t -> t+1.
    held = target.shift(1).fillna(0.0)
    # ----------------------------------------------------------------------

    gross = held * market_ret

    # Turnover is charged when the target changes (executed into the next bar).
    turnover = target.diff().abs().fillna(target.abs())
    cost = cost_model.apply(turnover.shift(1).fillna(0.0), participation)

    net = gross - cost
    equity = metrics.equity_curve(net)

    return BacktestResult(
        returns_net=net,
        returns_gross=gross,
        position=held,
        turnover=turnover,
        equity=equity,
        periods_per_year=periods_per_year,
    )
