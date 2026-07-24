"""Backlog #3 — funding-extreme directional fade — through the Validation Gauntlet.

DIRECTIONAL (not carry): when perp funding is extreme, positioning is crowded on
one side; the crowded side is forced to unwind, so we FADE it — very positive
funding (crowded longs) -> short; very negative funding (crowded shorts) -> long.
Decided causally from a rolling z-score of funding. P&L is price-driven (position
x spot return), so this is a genuine directional bet, unlike the delta-neutral
carry book.

Mechanism (must be real): over-crowded leveraged longs PAY rich funding to hold;
that crowding is fragile and mean-reverts on unwinds/liquidations. Fading funding
extremes harvests the reversion of positioning, not the funding itself.

Real Binance data first; synthetic fallback says so loudly (machinery only).
Run:  python examples/run_funding_fade.py
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")   # Windows cp1252 safety
except (AttributeError, ValueError):
    pass
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np
import pandas as pd

from edgemachine import CostModel, DataStore, ResearchJournal
from edgemachine.gauntlet import run_gauntlet
from edgemachine.strategies import generate_synthetic_carry

PERIODS_PER_YEAR = 3 * 365   # 8h funding intervals


def funding_fade_position(funding: pd.Series, lookback: int = 30,
                          entry_z: float = 1.5) -> pd.Series:
    """Causal fade of funding extremes. z = (funding - rolling mean)/rolling std,
    using only data up to and including each bar. Short when z >= +entry_z
    (crowded longs), long when z <= -entry_z (crowded shorts), flat otherwise."""
    m = funding.rolling(lookback, min_periods=lookback).mean()
    s = funding.rolling(lookback, min_periods=lookback).std(ddof=0)
    z = (funding - m) / (s + 1e-12)
    pos = pd.Series(0.0, index=funding.index)
    pos[z >= entry_z] = -1.0
    pos[z <= -entry_z] = 1.0
    return pos


def load_data() -> tuple[pd.Series, pd.Series, str]:
    """Return (funding, spot_price, source_label)."""
    store = DataStore("data")
    try:
        funding, spot, _basis = store.fetch_funding_binance("BTCUSDT", intervals=2000)
        if len(funding) < 300:
            raise RuntimeError("too few funding rows")
        return funding, spot, "REAL Binance BTCUSDT perp funding + spot"
    except Exception as exc:
        print(f"[data] live funding unavailable ({exc!s}).")
        print("[data] --> falling back to SYNTHETIC (machinery test only).")
        funding, spot, _ = generate_synthetic_carry(n=2400)
        return funding, spot, "SYNTHETIC (offline fallback)"


def main() -> None:
    print("=" * 72)
    print("EDGE MACHINE — Funding-Extreme Directional Fade through the Gauntlet")
    print("=" * 72)

    funding, spot, source = load_data()
    print(f"\ndata source : {source}")
    print(f"intervals   : {len(funding)} x 8h  "
          f"({funding.index[0].date()} -> {funding.index[-1].date()})")
    print(f"mean funding: {funding.mean()*1e4:.3f} bps/8h | "
          f"std {funding.std()*1e4:.2f} bps | {(funding<0).mean()*100:.0f}% negative")
    px_vol = spot.pct_change(fill_method=None).std() * (PERIODS_PER_YEAR ** 0.5)
    print(f"spot vol    : {px_vol*100:.0f}%/yr (this is a DIRECTIONAL bet — full price risk)\n")

    def strategy_fn(price: pd.Series, lookback: int = 30, entry_z: float = 1.5) -> pd.Series:
        f = funding.reindex(price.index)
        return funding_fade_position(f, lookback=lookback, entry_z=entry_z)

    grid = {"lookback": [10, 30, 60, 90], "entry_z": [1.0, 1.5, 2.0, 2.5]}
    costs = CostModel(taker_fee_bps=5.0, half_spread_bps=2.0)   # single-leg directional
    print(f"grid   : {len(grid['lookback'])*len(grid['entry_z'])} variants (lookback x entry_z)")
    print(f"costs  : {costs.taker_fee_bps + costs.half_spread_bps:.0f} bps/turn (single leg)\n")

    with ResearchJournal("data/research_journal.db") as jrn:
        result = run_gauntlet(
            spot, strategy_fn, grid, cost_model=costs,
            periods_per_year=PERIODS_PER_YEAR,          # directional: P&L = pos x spot return
            journal=jrn, name="funding_fade",
            market="binance:BTCUSDT-perp",
            hypothesis="Extreme funding marks crowded positioning that reverts; fade it.",
            mechanism="Over-crowded leveraged longs pay rich funding and are forced to "
                      "unwind/liquidate; fading funding extremes harvests that reversion.",
        )

    print(result.summary_text())
    print("\n" + "-" * 72)
    if "SYNTHETIC" in source:
        print("SYNTHETIC DATA: validates the pipeline, NOT a live edge.")
    print("Directional bet: full spot price risk, single-leg costs. The rotation")
    print("p-value keeps autocorrelation (the real timing-skill null).")
    print("-" * 72)


if __name__ == "__main__":
    main()
