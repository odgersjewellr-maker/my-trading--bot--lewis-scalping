# Edge Machine — Handoff Briefing (for a fresh Claude session)

You're picking up a systematic **trading-edge research framework** called the
Edge Machine. This doc is self-contained: read it, then `README.md`, then the
code. Everything lives in the `edge-machine/` directory of this repo, on branch
`claude/hedge-fund-order-metrics-y5nai4`.

## What it is (in one paragraph)

A pipeline that **manufactures, validates, and retires trading edges** — the
pipeline is the product, individual signals are disposable. It is deliberately
*self-skeptical*: most of the code exists to stop you fooling yourself with
overfit backtests. It targets crypto (funding, basis, perps) but the machinery
is asset-agnostic. Dependencies are just `pandas` + `numpy` (optional `pyarrow`,
`ccxt`); the research journal uses stdlib `sqlite3`.

## Current state — READ THIS

The machine is **structurally complete (Phases 0–3) and fully tested, but has
found ZERO real edges** — every test so far ran on *synthetic* data because the
environment it was built in blocked live exchange access (org egress policy
denied `fapi.binance.com` with a 403 on CONNECT). 

**The single highest-value task is to run real crypto data through it.** If your
environment can reach Binance, you can get the first real verdicts.

## The honesty ethos (do not violate this)

This project lives or dies on intellectual honesty. Hold the line:

- **Synthetic results validate the machinery, not an edge.** Never present a
  synthetic run as evidence a strategy works.
- **A Sharpe above ~4–5 is a red flag, not a win** — almost always a modeling
  artifact or look-ahead. Investigate, don't celebrate.
- **The gauntlet is designed to REJECT.** ~90% mortality is healthy. Do not
  loosen thresholds or tune parameters to force a pass.
- **Model costs realistically** before believing anything. For carry that means
  funding − Δbasis − hedge slippage − both-leg fees (all already implemented).
- If you're unsure whether a result is real, assume it isn't and say so.

## Setup & smoke test

```bash
cd edge-machine
pip install -r requirements.txt          # pandas + numpy is enough
python examples/machine_status.py        # runs the whole loop; should print KPIs
```

All demos run offline (synthetic fallback). If they run, the framework is intact.

## The architecture (4 phases)

| Phase | Modules | What it does |
|---|---|---|
| 0 — factory floor | `data`, `costs`, `backtest`, `metrics`, `journal` | point-in-time data (ccxt or synthetic), realistic cost model, vectorized backtester with **look-ahead protection**, sqlite research journal |
| 1 — Validation Gauntlet | `validation`, `gauntlet` | Deflated/Probabilistic Sharpe, PBO (CSCV), walk-forward, plateau, regime, **shuffle + rotation** nulls → one PASS/REJECT verdict |
| Idea backlog | `backlog` | 16 mechanism-first crypto hypotheses, scored & ranked |
| First edge | `strategies` | funding carry (delta-neutral), with basis P&L + hedge slippage |
| 2 — monitoring | `monitor`, `paper` | ExpectedBand, LiveMonitor (drawdown/CUSUM/rolling-Sharpe → OK/WARN/KILL), forward paper-trading harness |
| 3 — portfolio | `portfolio`, `cadence` | correlation-aware allocation (inverse-var / min-var / risk-parity), machine-health KPIs |

## THE KEY TASK: run funding carry on real data

```bash
python examples/run_funding_carry.py
```

This auto-tries real Binance funding+basis via `DataStore.fetch_funding_binance()`
(stdlib HTTP, honours `HTTPS_PROXY` + the proxy CA at `/root/.ccr/ca-bundle.crt`),
and falls back to synthetic if blocked. It prints the data source loudly.

- **If it says "REAL Binance …"** → the gauntlet verdict is meaningful. Report it
  honestly, including all 8 checks. A REJECT is a perfectly good, honest outcome.
- **If it says "SYNTHETIC …"** → your environment also blocks Binance. Options:
  (a) run it somewhere with exchange access, or (b) supply a CSV/parquet of real
  funding + spot + perp closes and adapt `load_data()` in the example to read it.

If Binance is geo/policy-blocked, DO NOT try to bypass it — report it and ask the
user for a reachable environment or a data file.

## How to test another backlog idea (the repeatable recipe)

The backlog (`edgemachine/backlog.py`, or `BACKLOG.md`) has 16 ranked ideas.
Ranked top-down; carry trades rank highest for retail. To test one:

1. Write a `strategy_fn(price, **params) -> position` (position in [-1, 1],
   decided causally — no look-ahead).
2. For non-directional edges (carry, basis), compute the return stream the
   position earns and pass it as `asset_return=`; add continuous costs via
   `holding_cost=`.
3. Run it:

```python
from edgemachine import CostModel, ResearchJournal
from edgemachine.gauntlet import run_gauntlet

with ResearchJournal("data/research_journal.db") as jrn:
    result = run_gauntlet(
        price, strategy_fn,
        param_grid={"lookback": [10, 20, 30], "entry_z": [1.0, 1.5, 2.0]},
        cost_model=CostModel(taker_fee_bps=5, half_spread_bps=2),
        asset_return=None,        # or the funding/carry return stream
        holding_cost=None,        # or a continuous slippage series
        periods_per_year=365,     # 1095 for 8h bars, etc.
        journal=jrn, name="my_edge",
        mechanism="who is forced to trade against me and why",  # required to be real
    )
print(result.summary_text())
```

4. If it PASSES: promote to paper with `run_paper()` under a `LiveMonitor`
   (see `examples/demo_monitoring.py`), calibrating the kill switch on the
   strategy's own healthy history first.
5. Combine multiple passing edges with `build_portfolio(returns_df,
   method="risk_parity")` — the payoff is diversification across *uncorrelated*
   edges (see `examples/demo_portfolio.py`).

## Roadmap / where to add value

1. **Run real data** (above) — by far the most valuable.
2. Implement more backlog strategies (cash-and-carry basis is #2, cross-sectional
   reversal, funding-timestamp effect are cheap to test).
3. Refine carry: add exchange/counterparty & liquidation risk (currently omitted;
   noted in the run output).
4. Persist paper/live monitor state across restarts; wire a real exchange feed
   into `run_paper` (the control flow already matches live).

## Git / workflow

Work on branch `claude/hedge-fund-order-metrics-y5nai4`. Commit with clear
messages; push with `git push -u origin claude/hedge-fund-order-metrics-y5nai4`.
Keep generated artifacts out of git — `data/*.db`, `*.parquet`, `*.csv` are
gitignored. Don't create a PR unless the user asks.
