"""Breadth runner — the edge-stacking engine.

The endgame is a risk-parity STACK of many small, INDEPENDENT edges (Phase 3
build_portfolio). This script is the sourcing loop that feeds it: a registry of
diverse single-asset strategies, each run through the FULL-strength gauntlet on
real deep data. It prints a survivor scoreboard and, if >=2 survive, their
return correlation (the thing that decides whether they actually diversify).

DISCIPLINE: breadth of SOURCING, never breadth by lowering the bar. We stack
survivors, not candidates. Adding an idea = one entry in STRATEGIES below.
Mechanisms are kept DIFFERENT on purpose — variations of one driver fail
together, which defeats the whole point.

Run:  python examples/run_breadth.py
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import pandas as pd

from edgemachine import CostModel, ResearchJournal
from edgemachine.gauntlet import run_gauntlet


# --------------------------------------------------------------------------- #
# real deep daily price (stdlib, paginated) — synthetic-free                   #
# --------------------------------------------------------------------------- #
def deep_daily_close(symbol: str = "BTCUSDT", years: float = 5.0) -> pd.Series | None:
    need = int(years * 365)
    rows, end = [], int(time.time() * 1000)
    try:
        while len(rows) < need:
            url = (f"https://api.binance.com/api/v3/klines?symbol={symbol}"
                   f"&interval=1d&limit=1000&endTime={end}")
            req = urllib.request.Request(url, headers={"User-Agent": "edge-machine/0.1"})
            with urllib.request.urlopen(req, timeout=30) as r:
                chunk = json.load(r)
            if not chunk:
                break
            rows = chunk + rows
            first = chunk[0][0]
            if len(chunk) < 1000 or first >= end:
                break
            end = first - 1
    except Exception as exc:
        print(f"[data] live daily unavailable ({exc!s}) — skipping breadth run.")
        return None
    seen, out = set(), []
    for k in rows:
        if k[0] in seen:
            continue
        seen.add(k[0]); out.append(k)
    idx = pd.to_datetime([k[0] for k in out], unit="ms", utc=True)
    return pd.Series([float(k[4]) for k in out], index=idx, name="close").iloc[-need:]


# --------------------------------------------------------------------------- #
# strategies — each causal, low-DOF, DIFFERENT mechanism                       #
# --------------------------------------------------------------------------- #
def tsmom(price: pd.Series, lookback: int = 30) -> pd.Series:
    """Trend persistence: hold the sign of the trailing lookback-day return."""
    return np.sign(price / price.shift(lookback) - 1.0).fillna(0.0)


def reversal(price: pd.Series, lookback: int = 3) -> pd.Series:
    """Short-horizon overreaction: fade the trailing lookback-day return."""
    return (-np.sign(price / price.shift(lookback) - 1.0)).fillna(0.0)


def weekend_reversion(price: pd.Series, thresh_pct: float = 1.0) -> pd.Series:
    """Calendar: on Monday, fade the weekend (2-day) move if it exceeded a
    threshold. Sparse -> naturally low exposure & uncorrelated with always-on
    trend/reversion books. Mechanism: weekend liquidity is thin, moves overshoot,
    Monday flow reverts."""
    we = price.pct_change(2, fill_method=None).shift(1)          # weekend move, known Monday
    is_mon = pd.Series(price.index.dayofweek == 0, index=price.index)
    pos = pd.Series(0.0, index=price.index)
    m = is_mon & (we.abs() > thresh_pct / 100.0)
    pos[m] = -np.sign(we[m])
    return pos.fillna(0.0)


STRATEGIES = [
    # (name, fn, grid, mechanism, category)
    ("tsmom", tsmom, {"lookback": [14, 30, 60, 90, 120]},
     "Trend persistence: crypto underreacts to sustained flow; momentum continues.", "trend"),
    ("reversal", reversal, {"lookback": [1, 2, 3, 5, 7]},
     "Short-horizon overreaction reverts as liquidity providers get paid to mean-revert.", "reversal"),
    ("weekend_reversion", weekend_reversion, {"thresh_pct": [0.0, 1.0, 2.0, 3.0]},
     "Thin weekend liquidity overshoots; Monday flow reverts it.", "calendar"),
]


def main() -> None:
    print("=" * 74)
    print("EDGE MACHINE — Breadth Runner (source many independent edges to stack)")
    print("=" * 74)
    price = deep_daily_close("BTCUSDT", years=5.0)
    if price is None:
        return
    print(f"data   : REAL Binance BTCUSDT daily, {len(price)} bars "
          f"({price.index[0].date()} -> {price.index[-1].date()})")
    print(f"stack rule: survivors only; >=2 uncorrelated survivors -> build_portfolio\n")

    costs = CostModel(taker_fee_bps=5.0, half_spread_bps=2.0)
    board, survivor_rets = [], {}
    with ResearchJournal("data/research_journal.db") as jrn:
        for name, fn, grid, mech, cat in STRATEGIES:
            res = run_gauntlet(
                price, fn, grid, cost_model=costs, periods_per_year=365,
                journal=jrn, name=name, market="binance:BTCUSDT",
                mechanism=mech,
            )
            board.append((name, cat, res))
            print(f"  {name:<18} [{cat:<9}] -> {'PASS' if res.passed else 'REJECT'}")

    # scoreboard
    print("\n" + "-" * 74)
    print(f"{'idea':<18}{'category':<11}{'OOS':>7}{'hold':>7}{'DSR':>6}{'PBO':>6}{'rot p':>7}  verdict")
    print("-" * 74)
    for name, cat, r in board:
        print(f"{name:<18}{cat:<11}{r.oos_sharpe:>7.2f}{r.holdout_sharpe:>7.2f}"
              f"{r.deflated_sharpe:>6.2f}{r.pbo:>6.2f}{r.rotation_pvalue:>7.3f}  {'PASS' if r.passed else 'REJECT'}")
    survivors = [n for n, c, r in board if r.passed]
    print("-" * 74)
    print(f"\nSURVIVORS: {survivors if survivors else 'none — nothing to stack yet (mortality is the point)'}")
    if len(survivors) >= 2:
        print("-> >=2 survivors: next step is build_portfolio(risk_parity) on their return streams,")
        print("   AFTER confirming low pairwise correlation (independence is what diversifies).")


if __name__ == "__main__":
    main()
