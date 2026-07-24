"""Backlog #1 — funding carry — through the Validation Gauntlet.

Tries real Binance funding data first; if the environment blocks it (geo-fence
or org network policy), falls back to a realistic SYNTHETIC funding series and
says so loudly. Synthetic results validate the machinery only — the real verdict
needs real data (run this where Binance is reachable).

Run:  python examples/run_funding_carry.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pandas as pd

from edgemachine import CostModel, DataStore, ResearchJournal
from edgemachine.gauntlet import run_gauntlet
from edgemachine.strategies import (
    carry_asset_return, carry_strategy_factory, generate_synthetic_carry,
)

PERIODS_PER_YEAR = 3 * 365  # 8h funding intervals


def load_data() -> tuple[pd.Series, pd.Series, pd.Series, str]:
    """Return (funding, spot, basis, source_label)."""
    store = DataStore("data")
    try:
        funding, spot, basis = store.fetch_funding_binance("BTCUSDT", intervals=2000)
        if len(funding) < 300:
            raise RuntimeError("too few funding rows returned")
        return funding, spot, basis, "REAL Binance BTCUSDT perp funding + basis"
    except Exception as exc:
        print(f"[data] live funding unavailable ({exc!s}).")
        print("[data] --> falling back to SYNTHETIC funding+basis (machinery test only).")
        funding, spot, basis = generate_synthetic_carry(n=2400)
        return funding, spot, basis, "SYNTHETIC (offline fallback)"


def main() -> None:
    print("=" * 72)
    print("EDGE MACHINE — Funding Carry through the Gauntlet")
    print("=" * 72)

    funding, spot, basis, source = load_data()
    carry_ret = carry_asset_return(funding, basis)
    ann_funding = funding.mean() * PERIODS_PER_YEAR
    print(f"\ndata source : {source}")
    print(f"intervals   : {len(funding)} x 8h  "
          f"({funding.index[0].date()} -> {funding.index[-1].date()})")
    print(f"mean funding: {funding.mean()*1e4:.3f} bps / 8h  "
          f"(~{ann_funding*100:.1f}% annualized if always long-carry)")
    print(f"% intervals negative funding: {(funding < 0).mean()*100:.1f}%")
    print(f"basis (perp premium): mean {basis.mean()*1e4:.1f} bps, "
          f"MTM vol {basis.diff().std()*1e4:.1f} bps/interval")
    # Decompose the +1-carry return stream into its two legs.
    fund_vol = funding.std() * (PERIODS_PER_YEAR ** 0.5)
    tot_vol = carry_ret.std() * (PERIODS_PER_YEAR ** 0.5)
    print(f"return vol  : funding-only {fund_vol*100:.1f}%/yr  ->  "
          f"with basis MTM {tot_vol*100:.1f}%/yr  "
          f"({tot_vol/max(fund_vol,1e-9):.1f}x more risk)\n")

    # Costs: a carry round-trip touches BOTH legs (spot + perp), so per unit of
    # turnover we pay ~2x a single-leg trade. Tune to your venue/fee tier.
    costs = CostModel(taker_fee_bps=10.0, half_spread_bps=2.0)  # ~12 bps/turn, both legs

    strategy_fn = carry_strategy_factory(funding)
    grid = {
        "entry_bps": [0.0, 0.5, 1.0, 2.0, 5.0],
        "smooth": [1, 3, 7, 14, 30],
    }
    print(f"grid   : {len(grid['entry_bps']) * len(grid['smooth'])} variants "
          f"(entry_bps x smooth)")
    print(f"costs  : {costs.taker_fee_bps + costs.half_spread_bps:.0f} bps/turn (both legs)\n")

    with ResearchJournal("data/research_journal.db") as jrn:
        result = run_gauntlet(
            spot, strategy_fn, grid, cost_model=costs,
            asset_return=carry_ret,             # P&L = funding - Δbasis, not price
            periods_per_year=PERIODS_PER_YEAR,
            journal=jrn, name="funding_carry",
            market="binance:BTCUSDT-perp",
            hypothesis="Long spot / short perp harvests positive funding, ~price-neutral.",
            mechanism="Over-leveraged directional longs must PAY funding to hold perps; "
                      "the delta-neutral carry trader collects it.",
        )

    print(result.summary_text())
    print("\n" + "-" * 72)
    if "SYNTHETIC" in source:
        print("SYNTHETIC DATA: this validates the pipeline end-to-end, NOT a live edge.")
        print("Re-run where Binance is reachable for the real verdict.")
    print("Model now includes basis mark-to-market (funding - Δbasis). Still omits")
    print("hedge slippage and exchange/counterparty risk — add those before trusting size.")
    print("-" * 72)


if __name__ == "__main__":
    main()
