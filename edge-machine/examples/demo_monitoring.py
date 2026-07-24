"""Phase 2 — live monitoring & kill switches in action.

Story in three acts:
  1. A mean-reversion edge is healthy on its research period; we snapshot what
     the backtest promised as an ExpectedBand.
  2. The market regime flips to a strong trend — the edge decays and the same
     strategy now bleeds.
  3. We paper-trade the strategy forward through the LiveMonitor. The kill
     switch detects the decay (CUSUM + drawdown breach) and flattens the book,
     versus a counterfactual with no kill switch that keeps losing.

Run:  python examples/demo_monitoring.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import pandas as pd

from edgemachine import (
    CostModel, ExpectedBand, KillSwitchConfig, run_paper, vectorized_backtest,
)

PPY = 365


def zscore_meanrev(price: pd.Series, lookback: int = 30, entry_z: float = 1.0) -> pd.Series:
    ma = price.rolling(lookback).mean()
    sd = price.rolling(lookback).std()
    z = (price - ma) / sd
    pos = pd.Series(0.0, index=price.index)
    pos[z < -entry_z] = 1.0
    pos[z > entry_z] = -1.0
    return pos


def ar1_meanreverting(n, seed, phi=0.92, sigma=0.02, start="2020-01-01"):
    rng = np.random.default_rng(seed)
    x = np.zeros(n)
    for t in range(1, n):
        x[t] = phi * x[t - 1] + rng.normal(0, sigma)
    return pd.Series(100 * np.exp(x), index=pd.date_range(start, periods=n, freq="D"))


def trending(n, seed, drift=0.004, sigma=0.02, start="2024-02-10"):
    rng = np.random.default_rng(seed)
    r = drift + rng.normal(0, sigma, n)
    return pd.Series(100 * np.exp(np.cumsum(r)), index=pd.date_range(start, periods=n, freq="D"))


def main() -> None:
    print("=" * 70)
    print("EDGE MACHINE — Phase 2: monitoring & kill switches")
    print("=" * 70)
    params = dict(lookback=30, entry_z=1.0)
    costs = CostModel(taker_fee_bps=5.0, half_spread_bps=2.0)

    # --- Act 1: healthy research period -> ExpectedBand --------------------
    full = ar1_meanreverting(1500, seed=1)
    train, calib = full.iloc[:1000], full.iloc[1000:]
    res = vectorized_backtest(train, zscore_meanrev(train, **params), costs, PPY)
    band = ExpectedBand.from_returns(res.returns_net, PPY)
    print(f"\n[1] research : Sharpe {res.stats['sharpe']:.2f}  |  {band.summary()}")

    kill_cfg = KillSwitchConfig(dd_breach_mult=1.5, cusum_h=8.0,
                                warn_rolling_window=40, warn_rolling_sharpe=0.0)

    # --- Act 1b: CALIBRATION — the kill switch must NOT fire on healthy data
    calib_run = run_paper(calib, zscore_meanrev, band, cost_model=costs,
                          config=kill_cfg, periods_per_year=PPY, **params)
    safe = calib_run.killed_at is None
    print(f"[1b] calibrate: on a healthy holdout the kill switch fired: "
          f"{'NO — thresholds safe' if safe else 'YES — too sensitive!'}")

    # --- Act 2: regime flips to a trend (edge decays) ---------------------
    live = trending(500, seed=2)
    print("[2] live     : regime flipped to a strong trend — fading it now bleeds")

    # --- Act 3: paper-trade forward, with vs without the kill switch ------
    protected = run_paper(live, zscore_meanrev, band, cost_model=costs,
                          config=kill_cfg, periods_per_year=PPY, **params)

    # counterfactual: kill switch effectively disabled
    no_kill = KillSwitchConfig(dd_breach_mult=1e9, cusum_h=1e9,
                               warn_rolling_sharpe=-1e9, warn_scale=1.0)
    blind = run_paper(live, zscore_meanrev, band, cost_model=costs,
                      config=no_kill, periods_per_year=PPY, **params)

    print("\n[3] paper-trading the decayed edge forward:\n")
    print("  WITH kill switch:")
    print(protected.summary_text())
    print("\n  WITHOUT kill switch (counterfactual):")
    print(blind.summary_text())

    saved = (protected.final_equity - blind.final_equity) * 100
    print("\n" + "-" * 70)
    if protected.killed_at is not None:
        first_kill = protected.log[protected.log["status"] == "KILL"].iloc[0]
        print(f"Kill fired {protected.killed_at.date()} — reason: {first_kill['reasons']}")
    print(f"Capital protected vs running blind: {saved:+.1f} pct of starting equity.")
    print("The kill rules were fixed BEFORE going live — no in-drawdown improvisation.")
    print("-" * 70)


if __name__ == "__main__":
    main()
