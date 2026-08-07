# Combiner — portfolio-level view across all research signals

**Status: research only. Not wired into `bot.js`, `rules.json`, or live execution. Nothing here places an order.**

The fifth piece, and a different kind of avenue from the other four: not a new alpha source, but the thing that was missing once three (now four) of them existed side by side with no way to answer "so what do I actually do." `report.js` pulls the current signal from `causal-fusion`, `stablecoin-flow`, `exchange-netflow`, and `llm-forecast` for a symbol and combines them into one position.

## How the weighting works — and what it honestly isn't

This is a **confidence-weighted opinion pool**, not portfolio optimization in the rigorous sense (no Markowitz, no covariance matrix). A real correlation-aware combiner needs historical return series from every signal, and two of these four don't have one yet: `exchange-netflow` is brand new, and `llm-forecast` has no backtest at all by design (see its README for why). Pretending otherwise would be dishonest, so this is the defensible version instead: each statistical signal gets a fixed base weight reflecting how much backtestable evidence currently exists behind it —

| Signal | Base weight | Why |
|---|---|---|
| causal-fusion | 1.0 | Hourly data, thousands of observations per rolling window, real backtest infrastructure |
| stablecoin-flow | 0.5 | Sparse events — see its own README's honesty section |
| exchange-netflow | 0.4 | Sparse events *and* single-wallet — the weakest evidence base of the three |
| llm-forecast | **0 until proven** | See below |

`llm-forecast`'s weight isn't a fixed tier — it's computed from its own scorecard: **zero** until there are 30+ resolved predictions, then scaled by actual accuracy (50% = zero weight, 75%+ = full weight, linear between). This is the honest version of "self-learning" applied one level up: the LLM signal has to earn a vote with logged evidence, the same way `reflect.js`'s playbook has to earn its 30-prediction floor before it's trusted.

The final position is a weighted average of each available signal's `conviction × sign`, normalized by total weight. If nothing is available or every available signal is unproven/excluded, the portfolio is `flat` with `0` conviction — not a fallback guess.

## Cost and safety

**Never calls the paid Claude API.** `llm-forecast`'s contribution here is read straight from `log/predictions.jsonl` — whatever was last logged by `predict.js`/`predict-batch.js`. If there's no unexpired prediction for the symbol, that signal just reports itself unavailable. This means `report.js` is free and safe to run as often as you like; it will never surprise you with a bill.

## Running it

```bash
npm install
node research/combiner/report.js BTCUSDT SOLUSDT
node research/combiner/report.js          # defaults to BTCUSDT, SOLUSDT
```

Output shows every signal's individual read (or why it's unavailable), then the combined portfolio position with a per-signal weight/contribution breakdown — so a `flat` result and a "yes I checked but nothing agreed enough" result look different, not the same silence.

## Files

| File | Purpose |
|---|---|
| `lib/signals/causalFusion.js` | Wraps causal-fusion's pipeline, computes the latest signal for a symbol |
| `lib/signals/stablecoinFlow.js` | Wraps stablecoin-flow's pipeline |
| `lib/signals/exchangeNetflow.js` | Wraps exchange-netflow's pipeline (BTC-only — reports unavailable for other symbols) |
| `lib/signals/llmForecast.js` | Reads llm-forecast's existing log (no API call) |
| `lib/combine.js` | The weighting/aggregation logic |
| `report.js` | CLI — prints the full breakdown per symbol |

## Note on this sandbox

All three statistical modules' data sources (Binance, Etherscan, mempool.space) are proxy-blocked here, so `report.js` was run for real and correctly showed every signal as unavailable with the *correct, specific* reason for each (network block, missing API key, BTC-only gating, no logged prediction) — confirming the cross-module imports resolve correctly and the fallback path works, without confirming anything about the actual signals' values. `combine.js`'s weighting math was independently verified against hand-calculated expected values for five cases (all-agree, a proven llm-forecast flipping the outcome, the exact accuracy-to-weight formula, nothing-available, and a mix of flat/directional signals) — all matched exactly. The real first run — seeing what the four signals actually say about BTC/SOL right now — needs to happen on your machine, with `ETHERSCAN_API_KEY` set and at least one `predict-batch.js` run behind you for the `llm-forecast` row to have anything to show.

## Suggested next steps

1. Once you've run the individual backtests for causal-fusion, stablecoin-flow, and exchange-netflow, check how correlated their equity curves actually are (each README already asks you to do this). If two are highly correlated, consider lowering one's base weight in `combine.js` — the fixed tiers above are a starting point, not gospel, and they're meant to be edited as you learn more.
2. Once `llm-forecast` clears 30 resolved predictions, watch how its weight actually behaves in `report.js` output over time rather than assuming it'll ever earn a meaningful vote.
3. The real upgrade path here is replacing `BASE_WEIGHTS` with weights derived from each module's realized Sharpe/correlation once there's enough live history — that's a materially better system than this one, just not honestly buildable yet.
