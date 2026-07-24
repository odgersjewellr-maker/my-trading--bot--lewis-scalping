"""Validation statistics — the machinery that stops you fooling yourself.

Pure functions, no orchestration. Every one is designed to *disprove* an edge:

  probabilistic_sharpe_ratio      confidence a Sharpe beats a benchmark, given
                                  sample length, skew and kurtosis
  deflated_sharpe_ratio           PSR against a benchmark inflated for the number
                                  of trials you ran (multiple-testing correction)
  probability_of_backtest_overfitting   CSCV: how often the in-sample best is
                                  below-median out-of-sample (i.e. luck)
  walk_forward_windows            expanding train/test splits through time
  parameter_plateau_score         do good params cluster (plateau) or spike (fit)
  regime_breakdown                does it hold across volatility regimes
  shuffle_test                    does randomized timing do just as well

Dependencies: numpy, pandas, and stdlib ``statistics.NormalDist`` for the normal
CDF / inverse-CDF — no scipy required.

References: Bailey & López de Prado, "The Deflated Sharpe Ratio" (2014);
López de Prado, "Advances in Financial Machine Learning" (2018), ch. 11-12.
"""

from __future__ import annotations

import itertools
from math import e as _E

import numpy as np
import pandas as pd
from statistics import NormalDist

from . import metrics

_ND = NormalDist()
_EULER = 0.5772156649015329  # Euler-Mascheroni constant


# --------------------------------------------------------------------------- #
# Sharpe-ratio significance                                                    #
# --------------------------------------------------------------------------- #
def per_bar_sharpe(returns) -> float:
    """Non-annualized (per-observation) Sharpe — the unit these formulas use."""
    r = np.asarray(returns, dtype=float)
    r = r[~np.isnan(r)]
    if len(r) < 2:
        return 0.0
    sd = r.std(ddof=1)
    return 0.0 if sd == 0 else float(r.mean() / sd)


def probabilistic_sharpe_ratio(returns, sr_benchmark: float = 0.0) -> float:
    """P(true per-bar Sharpe > sr_benchmark), adjusting for skew & fat tails.

    Returns a probability in [0, 1]. Higher = more confident the edge is real.
    """
    r = np.asarray(returns, dtype=float)
    r = r[~np.isnan(r)]
    n = len(r)
    if n < 3:
        return float("nan")
    sr = per_bar_sharpe(r)
    sd = r.std(ddof=0)
    if sd == 0:
        return float("nan")
    z = (r - r.mean()) / sd
    skew = float(np.mean(z ** 3))
    kurt = float(np.mean(z ** 4))  # full (non-excess) kurtosis; normal = 3
    denom = 1.0 - skew * sr + (kurt - 1.0) / 4.0 * sr ** 2
    if denom <= 0 or np.isnan(denom):
        return float("nan")
    stat = (sr - sr_benchmark) * np.sqrt(n - 1) / np.sqrt(denom)
    return float(_ND.cdf(stat))


def expected_max_sharpe(sr_variance: float, n_trials: int) -> float:
    """Expected maximum per-bar Sharpe from ``n_trials`` skill-less strategies.

    This is the bar an edge must clear just to beat luck when you've tried many
    variants. Grows with both the number of trials and their Sharpe dispersion.
    """
    if n_trials < 2 or sr_variance <= 0:
        return 0.0
    a = _ND.inv_cdf(1.0 - 1.0 / n_trials)
    b = _ND.inv_cdf(1.0 - 1.0 / (n_trials * _E))
    return float(np.sqrt(sr_variance) * ((1.0 - _EULER) * a + _EULER * b))


def deflated_sharpe_ratio(returns, all_trial_sharpes) -> tuple[float, float]:
    """Deflated Sharpe Ratio.

    ``all_trial_sharpes`` are the *per-bar* Sharpes of every variant you tried
    (including this one). Returns ``(dsr, sr_star)`` where ``dsr`` is the
    probability the selected strategy's Sharpe exceeds the trials-adjusted
    benchmark ``sr_star``. Treat dsr > 0.95 as the bar to clear.
    """
    s = np.asarray(all_trial_sharpes, dtype=float)
    s = s[~np.isnan(s)]
    n_trials = len(s)
    var_sr = float(np.var(s, ddof=1)) if n_trials > 1 else 0.0
    sr_star = expected_max_sharpe(var_sr, n_trials)
    return probabilistic_sharpe_ratio(returns, sr_benchmark=sr_star), sr_star


# --------------------------------------------------------------------------- #
# Probability of Backtest Overfitting (CSCV)                                   #
# --------------------------------------------------------------------------- #
def probability_of_backtest_overfitting(returns_matrix, n_blocks: int = 10):
    """Combinatorially-Symmetric Cross-Validation PBO.

    ``returns_matrix`` is shape (T, N): per-bar returns for N variants. Splits
    time into ``n_blocks`` blocks, forms every way of choosing half as in-sample,
    picks the IS-best variant, and checks its out-of-sample rank. PBO is the
    fraction of splits where the IS winner lands below the OOS median — pure
    overfit. Want PBO < 0.5 (ideally well under).
    """
    R = np.asarray(returns_matrix, dtype=float)
    T, N = R.shape
    if N < 2:
        return float("nan"), np.array([])
    n_blocks -= n_blocks % 2  # must be even
    if n_blocks < 2:
        n_blocks = 2
    bs = T // n_blocks
    if bs == 0:
        return float("nan"), np.array([])
    R = R[: bs * n_blocks]
    blocks = R.reshape(n_blocks, bs, N)
    bsum = blocks.sum(axis=1)            # (S, N)
    bsumsq = (blocks ** 2).sum(axis=1)   # (S, N)

    def agg_sharpe(mask: np.ndarray) -> np.ndarray:
        cnt = bs * mask.sum()
        s = bsum[mask].sum(axis=0)
        ss = bsumsq[mask].sum(axis=0)
        mean = s / cnt
        var = np.maximum(ss / cnt - mean ** 2, 1e-18)
        return mean / np.sqrt(var)

    half = n_blocks // 2
    lambdas = []
    for is_idx in itertools.combinations(range(n_blocks), half):
        is_mask = np.zeros(n_blocks, dtype=bool)
        is_mask[list(is_idx)] = True
        is_sr = agg_sharpe(is_mask)
        oos_sr = agg_sharpe(~is_mask)
        n_star = int(np.argmax(is_sr))
        rank = int((oos_sr <= oos_sr[n_star]).sum())  # 1..N
        omega = min(max(rank / (N + 1), 1e-6), 1 - 1e-6)
        lambdas.append(np.log(omega / (1 - omega)))
    lambdas = np.asarray(lambdas)
    return float((lambdas < 0).mean()), lambdas


# --------------------------------------------------------------------------- #
# Walk-forward, plateau, regime, shuffle                                       #
# --------------------------------------------------------------------------- #
def walk_forward_windows(n_obs: int, n_splits: int = 5):
    """Yield (train_slice, test_slice) expanding-window folds through time."""
    fold = n_obs // (n_splits + 1)
    if fold == 0:
        return
    for i in range(n_splits):
        tr_end = (i + 1) * fold
        te_end = n_obs if i == n_splits - 1 else (i + 2) * fold
        yield slice(0, tr_end), slice(tr_end, te_end)


def parameter_plateau_score(sharpes, top_frac: float = 0.25) -> float:
    """1.0 = top variants cluster near the best (plateau); low = lonely spike (fit)."""
    s = np.sort(np.asarray(sharpes, dtype=float))[::-1]
    s = s[~np.isnan(s)]
    if len(s) == 0 or s[0] <= 0:
        return 0.0
    k = max(1, int(len(s) * top_frac))
    return float(np.mean(s[:k]) / s[0])


def regime_breakdown(returns: pd.Series, prices: pd.Series,
                     periods_per_year: int = 365, vol_window: int = 30) -> dict:
    """Sharpe in high- vs low-volatility regimes. Behavior should be explainable."""
    vol = prices.pct_change(fill_method=None).rolling(vol_window).std()
    med = vol.median()
    hi = returns[vol > med]
    lo = returns[vol <= med]
    return {
        "high_vol_sharpe": metrics.sharpe(hi, periods_per_year),
        "low_vol_sharpe": metrics.sharpe(lo, periods_per_year),
    }


def _strategy_sharpe(position: pd.Series, market_ret: pd.Series,
                     cost_rate: float, ppy: int) -> float:
    held = position.shift(1).fillna(0.0)
    turnover = position.diff().abs().fillna(position.abs())
    net = held * market_ret - turnover.shift(1).fillna(0.0) * cost_rate
    return metrics.sharpe(net, ppy)


def shuffle_test(position: pd.Series, market_ret: pd.Series, cost_rate: float = 0.0,
                 periods_per_year: int = 365, n_iter: int = 200, seed: int = 0):
    """Permutation null: does randomized entry timing do as well as the signal?

    Returns (actual_sharpe, p_value, null_distribution). p < 0.05 means the
    signal's *timing* matters beyond chance.
    """
    actual = _strategy_sharpe(position, market_ret, cost_rate, periods_per_year)
    rng = np.random.default_rng(seed)
    vals = position.to_numpy()
    null = np.empty(n_iter)
    for i in range(n_iter):
        perm = pd.Series(rng.permutation(vals), index=position.index)
        null[i] = _strategy_sharpe(perm, market_ret, cost_rate, periods_per_year)
    p = float((null >= actual).mean())
    return actual, p, null
