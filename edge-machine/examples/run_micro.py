"""Microstructure edges (order flow) — through the Gauntlet.

The last genuinely-unpicked crypto corner: AGGRESSOR FLOW. Binance futures klines
carry per-bar taker-buy volume (field 9), so delta = 2*taker_buy - volume and
CVD = cumsum(delta) are computable on deep history WITHOUT tick data. This is the
Valentini/Rosato "absorption / aggression" primitive, quantified.

Two OPPOSITE order-flow mechanisms (genuinely new vs all prior price/funding ideas):
  delta_momentum : aggressor flow is informed and PERSISTS  -> follow CVD slope.
  absorption_fade: heavy aggression that does NOT move price is ABSORBED by a
                   large passive defender -> reverse. (Valentini's core read.)

HONEST CAVEATS: (1) 15m is the first rung; real absorption is a 1m/L2 phenomenon
we approximate with bar delta. (2) Intraday frequency meets the Law-2 cost wall
head-on — costs are modeled and will likely dominate. A REJECT on costs is the
expected, honest outcome; a survivor here would be genuinely notable.

Run:  python examples/run_micro.py
"""
from __future__ import annotations

import gc
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

INTERVAL = "15m"
BARS_PER_YEAR = 365 * 24 * 4      # 15m
TARGET_BARS = 35000               # ~1 year; memory-conscious on this host


def fetch_flow(symbol="BTCUSDT", interval=INTERVAL, need=TARGET_BARS) -> pd.DataFrame:
    """Deep intraday futures klines -> close, volume, taker_buy (float32)."""
    rows, end = [], int(time.time() * 1000)
    while len(rows) < need:
        u = (f"https://fapi.binance.com/fapi/v1/klines?symbol={symbol}"
             f"&interval={interval}&limit=1500&endTime={end}")
        req = urllib.request.Request(u, headers={"User-Agent": "edge-machine/0.1"})
        with urllib.request.urlopen(req, timeout=30) as r:
            chunk = json.load(r)
        if not chunk:
            break
        rows = chunk + rows
        if len(chunk) < 1500 or chunk[0][0] >= end:
            break
        end = chunk[0][0] - 1
        time.sleep(0.04)
    seen, out = set(), []
    for k in rows:
        if k[0] not in seen:
            seen.add(k[0]); out.append(k)
    out = out[-need:]
    idx = pd.to_datetime(np.fromiter((k[0] for k in out), dtype=np.int64, count=len(out)),
                         unit="ms", utc=True)
    df = pd.DataFrame({
        "close": np.fromiter((float(k[4]) for k in out), np.float64, len(out)),
        "vol":   np.fromiter((float(k[5]) for k in out), np.float64, len(out)),
        "tbuy":  np.fromiter((float(k[9]) for k in out), np.float64, len(out)),
    }, index=idx)
    del rows, out
    gc.collect()
    df["delta"] = 2 * df["tbuy"] - df["vol"]                 # aggressor imbalance
    df["cvd"] = df["delta"].cumsum()
    return df


# --- strategies (causal, low-DOF) ------------------------------------------- #
def delta_momentum(price, flow, lookback=6):
    slope = flow["cvd"] - flow["cvd"].shift(lookback)         # net aggressor flow, lookback bars
    return np.sign(slope).fillna(0.0)


def absorption_fade(price, flow, z=2.0):
    """Fade a bar where aggression was strong but price did NOT follow (absorbed).
    delta_z = z-score of delta over a rolling window; bar_ret = this bar's return.
    Long when heavy SELLING was absorbed (delta<<0 but ret>=0); short the mirror."""
    d = flow["delta"]
    dz = (d - d.rolling(96).mean()) / (d.rolling(96).std(ddof=0) + 1e-12)
    ret = price.pct_change(fill_method=None)
    pos = pd.Series(0.0, index=price.index)
    pos[(dz <= -z) & (ret >= 0)] = 1.0                        # sellers absorbed -> up
    pos[(dz >= z) & (ret <= 0)] = -1.0                        # buyers absorbed -> down
    return pos.fillna(0.0)


def main() -> None:
    print("=" * 76)
    print("EDGE MACHINE — Microstructure / Order-Flow Edges through the Gauntlet")
    print("=" * 76)
    try:
        flow = fetch_flow()
    except Exception as exc:
        print(f"[data] futures klines unreachable ({exc!s}) — abort.")
        return
    price = flow["close"]
    tot_delta = flow["delta"].sum()
    print(f"data   : REAL Binance BTCUSDT-perp {INTERVAL}, {len(flow)} bars "
          f"({price.index[0].date()} -> {price.index[-1].date()})")
    print(f"flow   : net CVD {tot_delta:+.0f} | mean |imbalance/vol| "
          f"{(flow['delta'].abs()/flow['vol']).mean()*100:.0f}%\n")

    variants = [("delta_mom", delta_momentum, {"lookback": [3, 6, 12, 24]}, "momentum"),
                ("absorb_fade", absorption_fade, {"z": [1.5, 2.0, 2.5, 3.0]}, "reversal")]
    # intraday single-leg taker cost — the Law-2 wall
    costs = CostModel(taker_fee_bps=5.0, half_spread_bps=1.0)

    board = []
    with ResearchJournal("data/research_journal.db") as jrn:
        for tag, fn, grid, kind in variants:
            sfn = lambda p, _fn=fn, **kw: _fn(p, flow, **kw)
            res = run_gauntlet(
                price, sfn, grid, cost_model=costs, periods_per_year=BARS_PER_YEAR,
                journal=jrn, name=f"micro_{tag}", market="binance:BTCUSDT-perp",
                mechanism=("Aggressor flow is informed and persists (delta momentum)."
                           if kind == "momentum" else
                           "Heavy aggression absorbed by a passive defender reverses "
                           "(Valentini absorption)."),
            )
            board.append((tag, kind, res))
            print(f"  micro_{tag:<12} [{kind:<8}] -> {'PASS' if res.passed else 'REJECT'}")

    print("\n" + "-" * 76)
    print(f"{'idea':<16}{'kind':<10}{'IS':>7}{'OOS':>7}{'hold':>7}{'DSR':>6}"
          f"{'2xcost':>8}{'rot':>7}  verdict")
    print("-" * 76)
    for tag, kind, r in board:
        print(f"micro_{tag:<10}{kind:<10}{r.is_sharpe:>7.2f}{r.oos_sharpe:>7.2f}"
              f"{r.holdout_sharpe:>7.2f}{r.deflated_sharpe:>6.2f}{r.stressed_sharpe:>8.2f}"
              f"{r.rotation_pvalue:>7.3f}  {'PASS' if r.passed else 'REJECT'}")
    survivors = [t for t, k, r in board if r.passed]
    print("-" * 76)
    print(f"\nSURVIVORS: {survivors if survivors else 'none'}")
    print("Note: 15m kline-delta is the first rung; the real absorption edge is 1m/L2")
    print("(the firm's orderflow-depth collector) — a deeper build if a pulse appears here.")


if __name__ == "__main__":
    main()
