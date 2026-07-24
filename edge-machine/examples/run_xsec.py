"""Cross-sectional alt edges — through the Validation Gauntlet.

Moves off single-asset BTC into the ALT CROSS-SECTION, where dispersion creates
genuinely diversifiable edges. Each day we rank a universe of liquid coins by a
signal and hold a dollar-neutral long-short basket (long top tercile / short
bottom), equal-weight, rebalanced daily. P&L is the market-neutral spread; heavy
daily turnover is charged explicitly as a continuous cost.

ADAPTER (honest fit to a single-asset gauntlet): the basket's causal net-return
stream is fed as `asset_return` with a constant +1 position, so the gauntlet's
holdout / shuffle / rotation / 2x-cost / regime tests all apply to the real
long-short return. Each (mechanism x lookback) is a SEPARATE pre-specified idea
(no internal grid-search -> no in-run overfitting); multiplicity across the
variants tried is counted at the journal/roster level, which is the honest place.

Run:  python examples/run_xsec.py
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

UNIVERSE = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT",
            "SOLUSDT", "DOTUSDT", "LINKUSDT", "LTCUSDT", "TRXUSDT", "AVAXUSDT",
            "MATICUSDT", "ATOMUSDT", "XLMUSDT", "ETCUSDT", "BCHUSDT", "FILUSDT",
            "UNIUSDT", "NEARUSDT"]
COST_PER_TURN = 0.0007        # 7 bps/turn single-leg (taker + half-spread), alt-realistic
MIN_ASSETS = 8                # need a real cross-section each day
Q = 1 / 3.0                   # top/bottom tercile


def _daily_close(symbol: str, years: float) -> pd.Series | None:
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
            if len(chunk) < 1000 or chunk[0][0] >= end:
                break
            end = chunk[0][0] - 1
            time.sleep(0.05)
    except Exception as exc:
        print(f"[data] {symbol} failed ({exc!s})")
        return None
    if not rows:
        return None
    seen, out = set(), []
    for k in rows:
        if k[0] not in seen:
            seen.add(k[0]); out.append(k)
    idx = pd.to_datetime([k[0] for k in out], unit="ms", utc=True)
    return pd.Series([float(k[4]) for k in out], index=idx, name=symbol).iloc[-need:]


def build_panel(years: float = 5.0) -> pd.DataFrame:
    cols = {}
    for s in UNIVERSE:
        ser = _daily_close(s, years)
        if ser is not None and len(ser) > 200:
            cols[s] = ser
    panel = pd.DataFrame(cols).sort_index()
    return panel


def xsec_returns(panel: pd.DataFrame, ret: pd.DataFrame, lookback: int,
                 kind: str) -> tuple[pd.Series, pd.Series]:
    """Causal dollar-neutral long-short basket, fully vectorized. Returns
    (net_return, turnover); net_return_t is EARNED at t by weights set at t-1."""
    sig = panel.pct_change(lookback, fill_method=None)          # trailing lookback return
    if kind == "reversal":
        sig = -sig
    n = sig.notna().sum(axis=1)
    rp = sig.rank(axis=1, pct=True)                             # 0..1 cross-sectional rank
    longs = rp.gt(1 - Q)                                        # top tercile
    shorts = rp.le(Q)                                          # bottom tercile
    nl, ns = longs.sum(axis=1), shorts.sum(axis=1)
    W = longs.div(nl.replace(0, np.nan), axis=0).fillna(0.0) \
        - shorts.div(ns.replace(0, np.nan), axis=0).fillna(0.0)
    W = W.where(n >= MIN_ASSETS, 0.0)                           # need a real cross-section
    w_prev = W.shift(1).fillna(0.0)                             # weights set yesterday
    gross = (w_prev * ret).sum(axis=1)                          # earned today (causal)
    turnover = (W - w_prev).abs().sum(axis=1)
    net = gross - turnover.shift(1).fillna(0.0) * COST_PER_TURN
    return net.rename("xsec"), turnover.rename("turnover")


def main() -> None:
    print("=" * 76)
    print("EDGE MACHINE — Cross-Sectional Alt Edges through the Gauntlet")
    print("=" * 76)
    panel = build_panel(years=5.0)
    if panel.shape[1] < MIN_ASSETS:
        print(f"[data] only {panel.shape[1]} symbols — need >= {MIN_ASSETS}. Abort.")
        return
    cov = panel.notna().sum(axis=1)
    usable = panel.loc[cov >= MIN_ASSETS]
    print(f"data   : REAL Binance daily, {panel.shape[1]} coins, "
          f"{len(usable)} days with >= {MIN_ASSETS} assets "
          f"({usable.index[0].date()} -> {usable.index[-1].date()})")
    print(f"basket : dollar-neutral top/bottom tercile, daily rebalance, "
          f"{COST_PER_TURN*1e4:.0f} bps/turn\n")

    variants = [("xsec_mom", "momentum", lb) for lb in (30, 60, 90)] + \
               [("xsec_rev", "reversal", lb) for lb in (3, 7, 14)]

    board = []
    ret = panel.pct_change(fill_method=None)                          # computed ONCE
    strat_fn = lambda price, v=0: pd.Series(1.0, index=price.index)   # constant deploy
    with ResearchJournal("data/research_journal.db") as jrn:
        for tag, kind, lb in variants:
            net, turn = xsec_returns(panel, ret, lb, kind)
            net = net.loc[usable.index].dropna()
            if len(net) < 300:
                print(f"  {tag}-{lb:<3} skipped (too few days)"); continue
            price = (1 + net).cumprod().rename("nav")            # reference index for slicing
            res = run_gauntlet(
                price, strat_fn, {"v": [0]},
                cost_model=CostModel(taker_fee_bps=0.0, half_spread_bps=0.0),  # cost already in `net`
                asset_return=net, periods_per_year=365,
                journal=jrn, name=f"{tag}_{lb}", market="binance:alt-xsec",
                mechanism=("Alt dispersion: cross-sectional "
                           + ("momentum — flows persist across the weakest/strongest names."
                              if kind == "momentum" else
                              "reversal — over/undershoot names revert relative to peers.")),
            )
            ann = net.mean() * 365
            board.append((f"{tag}_{lb}", kind, res, ann))
            print(f"  {tag}_{lb:<3} [{kind:<8}] ann~{ann*100:5.1f}%  -> "
                  f"{'PASS' if res.passed else 'REJECT'}")

    print("\n" + "-" * 76)
    print(f"{'idea':<14}{'kind':<10}{'annR%':>7}{'OOS':>7}{'hold':>7}{'DSR':>6}"
          f"{'shuf':>7}{'rot':>7}  verdict")
    print("-" * 76)
    for name, kind, r, ann in board:
        print(f"{name:<14}{kind:<10}{ann*100:>7.1f}{r.oos_sharpe:>7.2f}{r.holdout_sharpe:>7.2f}"
              f"{r.deflated_sharpe:>6.2f}{r.shuffle_pvalue:>7.3f}{r.rotation_pvalue:>7.3f}  "
              f"{'PASS' if r.passed else 'REJECT'}")
    survivors = [n for n, k, r, a in board if r.passed]
    print("-" * 76)
    print(f"\nSURVIVORS: {survivors if survivors else 'none — nothing to stack yet'}")
    print(f"(multiplicity: {len(board)} pre-specified variants — count all at roster level)")


if __name__ == "__main__":
    main()
