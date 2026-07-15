# NKB Systematic Trend Bot — Pitch

*Prepared July 2026 · All results are simulated/paper — clearly labelled throughout. Nothing here is audited or a guarantee of future returns.*

---

## The one-liner

A fully automated crypto trend-following system with **prop-firm-grade risk architecture built in**, validated the hard way: walk-forward, out-of-sample, fees included — with the flattering numbers deliberately killed off before anyone risks capital on them.

---

## Why this is worth your time

Most retail systems pitch a curve-fit backtest. We did the opposite — we built the tooling to **destroy our own headline number** and pitched what survived:

| Measurement | Result ($1k basis, BTC daily, 2018–2026) |
|---|---|
| Naive backtest (in-sample optimised, zero fees) | +9,082% — **rejected as hindsight inflation** |
| Same, with fees + slippage | +8,193% — still rejected (in-sample) |
| Honest walk-forward out-of-sample, fees included — baseline | **+18%/yr at 68% max drawdown** |
| Walk-forward OOS after validated risk improvements | **+44%/yr at 24% max drawdown (MAR 1.83)** |

Benchmark over the same 5.9 OOS years: buy-and-hold BTC returned ~49%/yr but at a ~77% drawdown (MAR ≈ 0.6). The system's value is **risk-adjusted**: roughly 3× the return per unit of drawdown, with the bear-market exposure structurally removed by the trend filter.

Every claim above is reproducible from the repo: `node walkforward.js` and `node strategy-lab.js`.

## The system

**Signal.** Neural Kernel Bands (NKB): a Nadaraya-Watson kernel regression centreline with residual σ-bands and a sticky state machine — long above the upper band, short below the lower, hold in between. Pure breakout-following; no prediction, no discretion.

**Filters (validated, not decorative).** Each candidate filter was A/B tested walk-forward against baseline; we ship only what improved out-of-sample results:
- **Fixed-fractional risk sizing** — 2% of equity risked per trade against an ATR-based stop (MAR 1.43 vs 0.26 baseline)
- **ADX(14) entry gate ≥ 25** — fresh breakouts only taken when a measurable trend exists (combo MAR 1.83)
- Rejected by the same process: false-breakout filters, tighter mean-reversion overlays — they tested *worse* and are documented as such

**Risk architecture (the prop-relevant part).** The bot already runs a full challenge-simulation mode enforcing firm rules in code, not in promises:
- Static max-drawdown floor with an early **auto-flatten guard at 90% of the limit**
- Daily-loss guard with day-level halt and configurable firm reset time
- Notional leverage cap, profit-target lock, exchange-enforced preset stop on every entry order
- Every decision (including every *rejected* trade and the reason) logged to an audit trail; every fill written to a tax-ready CSV

## Live status — where the bot is right now

- **Infrastructure:** runs 24/7 on GitHub Actions (15-minute cron), zero-maintenance; also deployable to any VPS/cron. Brokers: BitGet (spot + futures, 1x), with a prop-venue execution path (Velotrade) already in the codebase.
- **Paper track record since 2 Jul 2026** (13 days, three concurrent books, fees simulated):
  - BTC book ($1k): **+1.3%**
  - SOL book ($1k): **+0.8%**
  - SOL prop-challenge sim ($100k, firm rules: +10% target / 6% max DD / 2x cap): **+3.6% ($103,556)** — no drawdown breach, no daily halt, guards live-tested
- **Code:** `github.com/odgersjewellr-maker/my-trading--bot--lewis-scalping` — research and validation tooling on branch `claude/1k-to-100k-strategies-xad3zs`.

## What we'll tell you unprompted (limitations)

1. **Validation is single-asset (BTC daily) so far.** Multi-asset confirmation (ETH, SOL) is tooled and queued; if the edge doesn't generalise, we'll say so.
2. **Small trade sample** — ~34 OOS trades over 5.9 years. The edge is real in the data we have, but confidence intervals are wide.
3. **The live paper books currently run a faster timeframe (15m) than the validated configuration (daily).** The validated settings are wired in as defaults; migration of the deployed schedule to daily is the next operational step.
4. All figures are paper/simulated. We want them stress-tested by your risk team, not taken on faith.

## The ask

A **challenge account / evaluation allocation** on the validated daily-timeframe configuration, with your risk limits encoded directly into the bot's guard layer (it's parameterised for exactly this). Downside is bounded by the drawdown guard in code; every decision is auditable from the logs.

---

*Contact: repo owner · Full methodology: `walkforward.js`, `strategy-lab.js`, `nkb-engine.js` · Decision logs: `safety-check-log-*.json` · Trade records: `trades-*.csv`*
