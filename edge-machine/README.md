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
| `edgemachine/validation.py` | **Phase 1** — the anti-self-deception stats: Deflated/Probabilistic Sharpe, PBO (CSCV), walk-forward, parameter-plateau, regime breakdown, shuffle test. |
| `edgemachine/gauntlet.py` | **Phase 1** — orchestrator: runs a param grid through the whole battery and returns one pass/reject verdict. |
| `config.py` | One place for all knobs (venue, fees, timeframe, holdout size). |
| `examples/demo_sma_crossover.py` | End-to-end smoke test: data → signal → cost-aware backtest → journal. |
| `examples/demo_gauntlet.py` | Runs a 25-variant grid through the Validation Gauntlet. |

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

## The Validation Gauntlet (Phase 1 — built)

A candidate must survive **all** checks; expect ~90% mortality.

```python
from edgemachine import CostModel
from edgemachine.gauntlet import run_gauntlet

result = run_gauntlet(price, my_strategy,
                      param_grid={"lookback": [10, 20, 30], "entry_z": [1.0, 1.5, 2.0]},
                      cost_model=CostModel(), mechanism="who is forced to trade against me")
print(result.summary_text())   # PASS / REJECT with every number behind it
```

Run `python examples/demo_gauntlet.py` to see it in action. The checks:

| Check | Passes when | Catches |
|---|---|---|
| Walk-forward OOS Sharpe | > 0 | fits that don't generalize forward |
| Locked holdout Sharpe | > 0 | data you tuned on masquerading as OOS |
| **Deflated Sharpe** | > 0.95 | a good Sharpe found only by trying many variants |
| **PBO** (CSCV) | < 0.5 | in-sample winner being below-median out-of-sample |
| Parameter plateau | > 0.5 | lonely-spike params vs a robust neighborhood |
| Sharpe @ 2× cost | > 0 | "edges" that are just unmodeled costs |
| Shuffle p-value | < 0.05 | signals no better than random timing |

Validated both ways: it rejects trendless noise, and it passes a genuinely
mean-reverting series **once there's enough data** to clear the trials penalty
(DSR rises 0.88 → 0.94 → 0.99 as history grows 800 → 1,500 → 3,000 bars).

## Next phases (not yet built)

- **Phase 2 — live:** paper → tiny live, monitoring + kill switches.
- **Phase 3 — portfolio:** correlation-aware allocation + the improvement cadence.
- **Idea backlog:** a scored set of mechanism-first crypto hypotheses to feed the gauntlet.

See the research-plan doc for the full spec.
