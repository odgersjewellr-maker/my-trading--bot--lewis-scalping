"""Backlog #6 — cross-venue funding dislocation — through the Gauntlet.

REGIME-ORTHOGONAL by construction: this is an ARB on the funding-rate SPREAD
between two venues (Binance vs Bybit), not a bet on price. A +1 unit = short the
higher-funding perp / long the lower-funding perp (same asset, opposite legs), so
BTC direction cancels; you collect (f_high - f_low) each 8h settlement and wear
only the small, mean-reverting inter-venue price divergence.

This is exactly the carry structure with the venue funding-SPREAD as "funding"
and the inter-venue price divergence as "basis", so we reuse carry_asset_return
+ carry_strategy_factory. No synthetic fallback: cross-venue needs both venues'
real data or it does not run.

Run:  python examples/run_xvenue_carry.py
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

from edgemachine import CostModel, DataStore, ResearchJournal
from edgemachine.gauntlet import run_gauntlet
from edgemachine.strategies import carry_asset_return, carry_strategy_factory

PERIODS_PER_YEAR = 3 * 365


def _get(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "edge-machine/0.1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def bybit_funding(symbol="BTCUSDT", need=2000) -> pd.Series:
    rows, end = [], None
    while len(rows) < need:
        u = (f"https://api.bybit.com/v5/market/funding/history?category=linear"
             f"&symbol={symbol}&limit=200" + (f"&endTime={end}" if end else ""))
        lst = _get(u)["result"]["list"]
        if not lst:
            break
        rows += lst
        end = int(lst[-1]["fundingRateTimestamp"]) - 1
        if len(lst) < 200:
            break
        time.sleep(0.05)
    idx = pd.to_datetime([int(r["fundingRateTimestamp"]) for r in rows], unit="ms", utc=True)
    return pd.Series([float(r["fundingRate"]) for r in rows], index=idx,
                     name="f_bybit").sort_index()


def bybit_perp_4h_open(symbol="BTCUSDT", need=4000) -> pd.Series:
    """4h-kline OPEN indexed by bar-open time = price AT the settlement instant
    (using close would sample 4h later and inject raw BTC move as fake divergence)."""
    rows, end = [], None
    while len(rows) < need:
        u = (f"https://api.bybit.com/v5/market/kline?category=linear&symbol={symbol}"
             f"&interval=240&limit=1000" + (f"&end={end}" if end else ""))
        lst = _get(u)["result"]["list"]
        if not lst:
            break
        rows += lst
        end = int(lst[-1][0]) - 1
        if len(lst) < 1000:
            break
        time.sleep(0.05)
    idx = pd.to_datetime([int(r[0]) for r in rows], unit="ms", utc=True)
    return pd.Series([float(r[1]) for r in rows], index=idx, name="perp_bybit").sort_index()


def binance_perp_4h_open(symbol="BTCUSDT", need=4000) -> pd.Series:
    """Binance perp 4h-kline OPEN at bar-open time — SAME sampling instant as
    the Bybit series so the divergence is a true same-time inter-venue spread."""
    rows, end = [], int(time.time() * 1000)
    while len(rows) < need:
        u = (f"https://fapi.binance.com/fapi/v1/klines?symbol={symbol}"
             f"&interval=4h&limit=1000&endTime={end}")
        lst = _get(u)
        if not lst:
            break
        rows = lst + rows
        if len(lst) < 1000 or lst[0][0] >= end:
            break
        end = lst[0][0] - 1
        time.sleep(0.05)
    idx = pd.to_datetime([int(r[0]) for r in rows], unit="ms", utc=True)
    return pd.Series([float(r[1]) for r in rows], index=idx, name="perp_bin").sort_index()


def main() -> None:
    print("=" * 74)
    print("EDGE MACHINE — Cross-Venue Funding Dislocation (Binance vs Bybit)")
    print("=" * 74)
    try:
        store = DataStore("data")
        fb, _spot, _basis = store.fetch_funding_binance("BTCUSDT", intervals=2000)
        f_by = bybit_funding("BTCUSDT", 2000)
        perp_bin = binance_perp_4h_open("BTCUSDT", 4000)        # same-instant OPEN prices
        perp_by = bybit_perp_4h_open("BTCUSDT", 4000)
    except Exception as exc:
        print(f"[data] a venue was unreachable ({exc!s}). Cross-venue needs both — abort.")
        return

    # align on the common 8h settlement timestamps: exact-match the 4h-open prices
    # to the funding times (00/08/16 UTC all exist in the 4h grid).
    df = pd.concat([fb.rename("f_bin"), f_by,
                    perp_bin.reindex(fb.index), perp_by.reindex(fb.index)],
                   axis=1, sort=True).dropna()
    if len(df) < 300:
        print(f"[data] only {len(df)} aligned settlements — too few. Abort.")
        return

    spread = (df["f_bin"] - df["f_bybit"]).rename("spread")     # venue funding differential
    divergence = (df["perp_bin"] / df["perp_bybit"] - 1.0).rename("divergence")
    print(f"data   : REAL Binance+Bybit, {len(df)} x 8h "
          f"({df.index[0].date()} -> {df.index[-1].date()})")
    print(f"spread : mean {spread.mean()*1e4:+.3f} bps/8h | std {spread.std()*1e4:.2f} | "
          f"|spread|>0.5bp on {(spread.abs()>5e-5).mean()*100:.0f}% of intervals")
    print(f"diverg : mean {divergence.mean()*1e4:+.1f} bps | MTM vol "
          f"{divergence.diff().std()*1e4:.1f} bps/interval (the risk leg)\n")

    carry_ret = carry_asset_return(spread, divergence)          # spread - Δdivergence
    strat = carry_strategy_factory(spread)                      # threshold on the spread
    grid = {"entry_bps": [0.0, 0.2, 0.5, 1.0], "smooth": [1, 3, 7]}
    # cross-venue flip touches BOTH perp legs on BOTH venues -> ~2x single-leg cost
    costs = CostModel(taker_fee_bps=10.0, half_spread_bps=4.0)
    print(f"grid   : {len(grid['entry_bps'])*len(grid['smooth'])} variants | "
          f"costs {costs.taker_fee_bps+costs.half_spread_bps:.0f} bps/turn (both venues)\n")

    price = (1 + carry_ret).cumprod().rename("nav")
    with ResearchJournal("data/research_journal.db") as jrn:
        res = run_gauntlet(
            price, strat, grid, cost_model=costs,
            asset_return=carry_ret, periods_per_year=PERIODS_PER_YEAR,
            journal=jrn, name="xvenue_funding_carry", market="binance-vs-bybit:BTCUSDT-perp",
            hypothesis="The Binance-Bybit funding spread is harvestable, price-neutral.",
            mechanism="Fragmented perp liquidity leaves venue funding rates dislocated; "
                      "shorting the richer / longing the cheaper collects the spread "
                      "while BTC direction cancels across the two legs.",
        )
    print(res.summary_text())
    print("\n" + "-" * 74)
    print("Regime-ORTHOGONAL: P&L is the funding SPREAD, not price direction. Risk leg =")
    print("inter-venue price divergence (small, mean-reverting). Omits withdrawal/")
    print("transfer & venue-solvency risk — real for a live 2-venue book.")
    print("-" * 74)


if __name__ == "__main__":
    main()
