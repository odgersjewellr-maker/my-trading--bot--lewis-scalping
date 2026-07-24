# Edge Machine

A systematic research pipeline for **crypto** trading edges. The durable asset
isn't any single signal — it's the machine that manufactures, validates, and
retires edges faster than they decay. This repo is **Phase 0**: the factory
floor. It gives you clean, reproducible plumbing so that when you start hunting
edges you can trust the numbers.

> Full strategy, the Validation Gauntlet, and the 90-day rollout live in
> `edge-machine-research-plan.md` (the design doc). This code implements Phase 0
> of that plan.

## What's here (Phase 0)

| Module | Responsibility |
|---|---|
| `edgemachine/data.py` | Point-in-time OHLCV storage. Live via **ccxt**, or a deterministic **synthetic** fallback so everything runs offline. |
| `edgemachine/costs.py` | Realistic transaction costs (fees + spread + optional √-impact), applied **before** you believe a backtest. |
| `edgemachine/backtest.py` | Vectorized backtester with built-in **look-ahead protection**. |
| `edgemachine/metrics.py` | Sharpe, Sortino, max drawdown, CAGR, hit rate, turnover. |
| `edgemachine/journal.py` | Research journal (stdlib sqlite). Logs every hypothesis **including `n_trials`** — the hook the gauntlet needs for multiple-testing correction. |
| `config.py` | One place for all knobs (venue, fees, timeframe, holdout size). |
| `examples/demo_sma_crossover.py` | End-to-end smoke test: data → signal → cost-aware backtest → journal. |

## Quick start

```bash
cd edge-machine
pip install -r requirements.txt          # pandas + numpy is enough; rest is optional
python examples/demo_sma_crossover.py
```

The demo runs **offline** out of the box (synthetic data). To use real Binance
data, install ccxt and set `source="ccxt"` in `config.py` — it caches a local
snapshot so your research stays reproducible.

### What the demo is telling you

SMA crossover is deliberately **not** a real edge. Watch the `cost drag/yr`
line in the output: it demonstrates the machine's core lesson — a raw signal is
not an edge until it survives realistic costs. That's the whole reason the cost
model and journal exist before any edge hunting begins.

## Design principles (short version)

1. Every edge decays → optimize research *throughput*, not one signal.
2. Your #1 enemy is self-deception → look-ahead protection, cost realism, and
   `n_trials` logging are built in from day one.
3. Mechanism before pattern → the journal *requires* you to state who loses and why.
4. Edges combine through low correlation, not individual greatness.

## Next phases (not yet built)

- **Phase 1 — Validation Gauntlet:** Deflated Sharpe, walk-forward, PBO,
  parameter-plateau + 2×-cost + regime tests. Reusable, drops onto any backtest.
- **Phase 2 — live:** paper → tiny live, monitoring + kill switches.
- **Phase 3 — portfolio:** correlation-aware allocation + the improvement cadence.

See the research-plan doc for the full spec.
