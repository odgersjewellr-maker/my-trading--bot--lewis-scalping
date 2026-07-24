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
| `edgemachine/backlog.py` | The scored, mechanism-first crypto **idea backlog** — the fuel the gauntlet burns. Source of truth for `BACKLOG.md`. |
| `config.py` | One place for all knobs (venue, fees, timeframe, holdout size). |
| `examples/demo_sma_crossover.py` | End-to-end smoke test: data → signal → cost-aware backtest → journal. |
| `examples/demo_gauntlet.py` | Runs a 25-variant grid through the Validation Gauntlet. |
| `examples/show_backlog.py` | Prints the ranked backlog, seeds it into the journal, regenerates `BACKLOG.md`. |

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
| Shuffle p-value | < 0.05 | signals no better than random timing (breaks autocorrelation) |
| **Rotation p-value** | < 0.05 | timing "skill" that's really just riding an autocorrelated signal (keeps autocorrelation — the honest null for persistent/carry edges) |

Validated both ways: it rejects trendless noise, and it passes a genuinely
mean-reverting series **once there's enough data** to clear the trials penalty
(DSR rises 0.88 → 0.94 → 0.99 as history grows 800 → 1,500 → 3,000 bars).

## The idea backlog (built)

16 mechanism-first crypto hypotheses, each scored 1-5 on six dimensions
(mechanism, capacity, executability, data, independence, durability) and ranked
by their product. See **`BACKLOG.md`** for the full table + detail cards, or:

```bash
python examples/show_backlog.py   # ranked list + seeds journal + regenerates BACKLOG.md
```

Top of the list is where retail edge actually lives — carry trades with a clear
forced counterparty (funding carry, cash-and-carry basis) rank highest;
liquidation-cascade fading ranks low *despite* the strongest mechanism because
its capacity is tiny and execution is colocation-hard. The backlog is the
source of truth (`edgemachine/backlog.py`); `BACKLOG.md` is generated from it.

## First real candidate: funding carry

Backlog #1 (funding carry) is implemented in `edgemachine/strategies.py` and run
through the gauntlet by `examples/run_funding_carry.py`. Because carry P&L is the
funding rate — not price direction — the backtester and gauntlet now accept an
`asset_return` stream that the position earns instead of price moves.

```bash
python examples/run_funding_carry.py   # tries real Binance funding, else synthetic
```

The carry return is modelled as **`funding − Δbasis − hedge slippage`**:

- **funding** you collect on the short perp,
- **− Δbasis** because you're *short the perp premium* (basis = perp/spot − 1) and
  wear its mark-to-market — the real risk/drawdown source of carry
  (see `carry_asset_return()` for the derivation),
- **− hedge slippage**, a continuous drag from rebalancing the two legs as price
  moves, modelled as a `holding_cost` proportional to `|spot move|` (an
  assumption you tune to your venue).

On the synthetic run these frictions matter: hedge slippage alone is ~8-9%/yr of
drag while deployed, against ~11%/yr gross funding — so realistic carry is thin,
which is the honest conclusion.

**Data access matters.** The script fetches real Binance funding + basis when
the network allows it. In restricted/geo-fenced environments (e.g. an org egress
policy denying `fapi.binance.com`) it falls back to a **synthetic** series and
says so — those results validate the machinery only. Adding basis P&L is what
makes the synthetic run honest: it drops the Sharpe from a fantasy ~15 (funding
alone) into a realistic ~1-4 band, adds ~4.5× the risk, and the gauntlet then
**rejects** a naively-tuned entry that collapses out-of-sample. Run it where
Binance is reachable for the real verdict. Still omitted: hedge slippage and
exchange/counterparty risk — add those before trusting size.

## Phase 2 — monitoring & kill switches (built)

Once an edge passes the gauntlet, this layer runs it forward and pulls the plug
on **pre-committed rules** — decided before deployment, not mid-drawdown.

```bash
python examples/demo_monitoring.py
```

- `ExpectedBand.from_returns()` — snapshots what the backtest promised (Sharpe +
  bootstrap CI, mean, vol, max drawdown): the yardstick for live behaviour.
- `LiveMonitor` — ingests realized returns bar by bar; emits **OK / WARN / KILL**
  plus a position scale. Detectors: drawdown-breach (live DD worse than
  `mult ×` backtest maxDD → KILL), a one-sided **CUSUM** on returns (persistent
  losses → KILL), and a rolling-Sharpe floor (→ WARN, half size). A KILL latches
  until a human resets it.
- `run_paper()` — steps a strategy forward the way live trading does (hold last
  bar's position, realize the return, feed the monitor, let the kill switch scale
  the *next* target). Swap the data iterator for a websocket and the same
  monitor/kill logic runs unchanged.

Two lessons the build surfaced, baked into the defaults:

1. **Reference decay detectors against zero, not the backtest mean.** A CUSUM
   referenced against the (optimistic, in-sample) backtest mean false-alarms on
   every healthy-but-regressed live series. The default fires on persistent
   *losses*; the "underperforming but still positive" zone is the WARN's job.
2. **Calibrate thresholds on the strategy's own healthy history.** The demo
   verifies the kill switch does *not* fire on a healthy holdout before trusting
   it live. In the decay scenario the switch cuts a −49% blind loss to −28%.

## Next phases (not yet built)

- **Phase 3 — portfolio:** correlation-aware allocation + the improvement cadence.

See the research-plan doc for the full spec.
