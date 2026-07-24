"""The Validation Gauntlet — orchestrator.

Takes a strategy function and a parameter grid, runs the full battery from
``validation.py``, and returns a single pass/reject verdict with every number
that produced it. A candidate must survive ALL checks. Expect ~90% mortality;
that is the gauntlet working, not failing.

Usage
-----
    from edgemachine import CostModel
    from edgemachine.gauntlet import run_gauntlet

    def my_strategy(price, lookback, entry_z):
        ...  # return a position Series in [-1, 1], decided causally
        return position

    result = run_gauntlet(
        price, my_strategy,
        param_grid={"lookback": [10, 20, 30], "entry_z": [1.0, 1.5, 2.0]},
        cost_model=CostModel(),
        mechanism="Who is forced to trade against me, and why.",
    )
    print(result.summary_text())
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .backtest import vectorized_backtest
from .costs import CostModel
from . import metrics, validation as val


@dataclass
class GauntletResult:
    name: str
    best_params: dict
    n_trials: int
    is_sharpe: float          # in-sample (research) Sharpe of the winner
    oos_sharpe: float         # walk-forward average OOS Sharpe
    holdout_sharpe: float     # locked holdout, evaluated once
    deflated_sharpe: float    # probability winner beats trials-adjusted benchmark
    sr_star: float            # the trials-adjusted benchmark (per-bar)
    pbo: float                # probability of backtest overfitting
    plateau_score: float
    stressed_sharpe: float    # Sharpe under 2x costs
    shuffle_pvalue: float
    regimes: dict
    checks: dict = field(default_factory=dict)
    passed: bool = False

    def summary_text(self) -> str:
        def mark(ok):  # noqa: ANN001
            return "PASS" if ok else "FAIL"
        lines = [
            f"GAUNTLET: {self.name}",
            f"  best params        : {self.best_params}   (of {self.n_trials} trials)",
            "  " + "-" * 58,
            f"  in-sample Sharpe   : {self.is_sharpe:7.2f}",
            f"  walk-fwd OOS Sharpe: {self.oos_sharpe:7.2f}   [{mark(self.checks.get('oos_positive'))}]",
            f"  holdout Sharpe     : {self.holdout_sharpe:7.2f}   [{mark(self.checks.get('holdout_positive'))}]",
            f"  Deflated Sharpe    : {self.deflated_sharpe:7.2f}   [{mark(self.checks.get('deflated_sharpe'))}]  (SR* bar={self.sr_star:.3f}/bar)",
            f"  PBO                : {self.pbo:7.2f}   [{mark(self.checks.get('pbo'))}]  (lower=better)",
            f"  plateau score      : {self.plateau_score:7.2f}   [{mark(self.checks.get('plateau'))}]",
            f"  Sharpe @ 2x cost   : {self.stressed_sharpe:7.2f}   [{mark(self.checks.get('survives_2x_cost'))}]",
            f"  shuffle p-value    : {self.shuffle_pvalue:7.3f}   [{mark(self.checks.get('shuffle'))}]",
            f"  regime  hi/lo vol  : {self.regimes.get('high_vol_sharpe', float('nan')):.2f} / {self.regimes.get('low_vol_sharpe', float('nan')):.2f}",
            "  " + "-" * 58,
            f"  VERDICT            : {'>>> PASS — advance to paper' if self.passed else 'REJECT'}",
        ]
        return "\n".join(lines)


def run_gauntlet(
    price: pd.Series,
    strategy_fn,
    param_grid: dict,
    cost_model: CostModel | None = None,
    *,
    periods_per_year: int = 365,
    holdout_frac: float = 0.2,
    n_splits: int = 5,
    pbo_blocks: int = 10,
    shuffle_iter: int = 200,
    dsr_threshold: float = 0.95,
    pbo_threshold: float = 0.5,
    plateau_threshold: float = 0.5,
    shuffle_alpha: float = 0.05,
    journal=None,
    name: str = "edge",
    mechanism: str = "",
    hypothesis: str = "",
    market: str = "",
) -> GauntletResult:
    cost_model = cost_model or CostModel()
    price = price.dropna().astype(float)
    n = len(price)

    # Locked holdout — the winner touches this exactly once, at the very end.
    cut = int(n * (1 - holdout_frac))
    research = price.iloc[:cut]
    holdout_idx = price.index[cut:]
    research_ret = research.pct_change(fill_method=None).fillna(0.0)
    cost_rate = cost_model.rate_per_turnover()

    # --- grid search on RESEARCH data only ---------------------------------
    combos = [dict(zip(param_grid, vals))
              for vals in itertools.product(*param_grid.values())]
    ret_cols, trial_sharpes = [], []
    for params in combos:
        pos = strategy_fn(research, **params).reindex(research.index).fillna(0.0)
        net = vectorized_backtest(research, pos, cost_model, periods_per_year).returns_net
        ret_cols.append(net.to_numpy())
        trial_sharpes.append(val.per_bar_sharpe(net.to_numpy()))
    R = np.column_stack(ret_cols)                       # (T, N)
    trial_sharpes = np.asarray(trial_sharpes)

    # --- pick winner by walk-forward OOS (honest selection) ----------------
    wf = np.full(len(combos), np.nan)
    for j in range(len(combos)):
        scores = [metrics.sharpe(pd.Series(R[te, j]), periods_per_year)
                  for _, te in val.walk_forward_windows(len(research), n_splits)]
        if scores:
            wf[j] = float(np.mean(scores))
    if np.all(np.isnan(wf)):
        raise ValueError("Walk-forward produced no scores; need more data or fewer splits.")
    best_j = int(np.nanargmax(wf))
    best_params = combos[best_j]
    best_net = pd.Series(R[:, best_j], index=research.index)

    is_sharpe = metrics.sharpe(best_net, periods_per_year)
    oos_sharpe = float(wf[best_j])

    # --- the battery -------------------------------------------------------
    dsr, sr_star = val.deflated_sharpe_ratio(best_net.to_numpy(), trial_sharpes)
    pbo, _ = val.probability_of_backtest_overfitting(R, n_blocks=pbo_blocks)
    plateau = val.parameter_plateau_score(trial_sharpes)

    stressed = vectorized_backtest(
        research, strategy_fn(research, **best_params).reindex(research.index).fillna(0.0),
        cost_model.stressed(2.0), periods_per_year,
    ).stats["sharpe"]

    best_pos = strategy_fn(research, **best_params).reindex(research.index).fillna(0.0)
    _, shuffle_p, _ = val.shuffle_test(
        best_pos, research_ret, cost_rate, periods_per_year, shuffle_iter)

    regimes = val.regime_breakdown(best_net, research, periods_per_year)

    # --- holdout: compute on FULL series (causal history), read holdout slice
    full_net = vectorized_backtest(
        price, strategy_fn(price, **best_params).reindex(price.index).fillna(0.0),
        cost_model, periods_per_year,
    ).returns_net
    holdout_sharpe = metrics.sharpe(full_net.loc[holdout_idx], periods_per_year)

    checks = {
        "oos_positive": oos_sharpe > 0,
        "holdout_positive": holdout_sharpe > 0,
        "deflated_sharpe": (not np.isnan(dsr)) and dsr > dsr_threshold,
        "pbo": (not np.isnan(pbo)) and pbo < pbo_threshold,
        "plateau": plateau > plateau_threshold,
        "survives_2x_cost": stressed > 0,
        "shuffle": shuffle_p < shuffle_alpha,
    }
    passed = all(checks.values())

    result = GauntletResult(
        name=name, best_params=best_params, n_trials=len(combos),
        is_sharpe=is_sharpe, oos_sharpe=oos_sharpe, holdout_sharpe=holdout_sharpe,
        deflated_sharpe=dsr, sr_star=sr_star, pbo=pbo, plateau_score=plateau,
        stressed_sharpe=stressed, shuffle_pvalue=shuffle_p, regimes=regimes,
        checks=checks, passed=passed,
    )

    if journal is not None:
        stats = vectorized_backtest(research, best_pos, cost_model, periods_per_year).stats
        journal.log(
            name=name, market=market, hypothesis=hypothesis, mechanism=mechanism,
            params=best_params, n_trials=len(combos),
            sharpe=is_sharpe, oos_sharpe=oos_sharpe,
            max_drawdown=stats["max_drawdown"], cagr=stats["cagr"],
            avg_turnover=stats["avg_turnover"], cost_drag=stats["cost_drag_annual"],
            stage="gauntlet", verdict="pass" if passed else "reject",
            notes=f"DSR={dsr:.3f} PBO={pbo:.3f} plateau={plateau:.2f} "
                  f"holdout_sr={holdout_sharpe:.2f} shuffle_p={shuffle_p:.3f}",
        )
    return result
