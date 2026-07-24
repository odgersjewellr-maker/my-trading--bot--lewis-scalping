# Edge Machine — Real-Data Results

Honest log of gauntlet verdicts on REAL exchange data. Synthetic runs are not
recorded here (they validate machinery, not edges — see HANDOFF.md ethos).

## 2026-07-24 — funding carry (Backlog #1) — **REJECT** — FIRST REAL VERDICT

The machine's first-ever run on live data (all prior runs were synthetic because
the build environment blocked Binance). Fetched via `fetch_funding_binance()` on
a host with open egress.

- **Data:** REAL Binance BTCUSDT perp funding + basis, 500 × 8h intervals
  (2026-02-08 → 2026-07-24).
- **Regime:** mean funding **0.116 bps/8h (~1.3%/yr)**, **38.4% of intervals
  negative**. Basis mean −4.9 bps. Carry return vol ~0.2–0.5%/yr.
- **Gauntlet:** all 8 checks FAIL → **REJECT**. Best params entry_bps=1.0,
  smooth=3. OOS/holdout/2x-cost Sharpe all 0.00; PBO 0.64; shuffle p=1.00;
  rotation p=1.00; DSR nan.
- **Honest read — the 0.00 Sharpes are "barely-traded", not "traded-and-lost":**
  the entry threshold (1.0 bps/8h) is ~9× the mean funding, so the delta-neutral
  book is almost always flat. There is essentially no positive carry to harvest
  in the current BTC funding regime, and what little exists does not clear the
  ~12 bps/turn both-leg fees + ~4.9%/yr hedge-slippage drag vs ~1.3%/yr gross.
- **Independent corroboration:** matches a separate firm study (2026-07-15)
  finding carry is frenzy-concentrated (bulk of PnL from the 2020–21 bull, ~0 in
  calm; dormant in low-funding windows). Two independent codebases, same answer.
- **Omitted (would only worsen it):** exchange/counterparty & liquidation risk.
- **Reproduce:** `python examples/run_funding_carry.py` on a host that can reach
  `fapi.binance.com` (public endpoints, no keys).

**Takeaway:** the pipeline is validated on real data (rejects a dead edge
correctly; the smoke test passes a true synthetic effect and rejects noise).
A REJECT here is the machine working as designed — not a failure.

## 2026-07-24 — DATA-DEPTH FIX (was silently limited to 500 intervals)

`fetch_funding_binance` assumed the funding endpoint returns 1000 rows/call and
broke its paging loop on `len(batch) < 1000` — but Binance caps fundingRate at
**500/call**, so the loop always stopped after ONE page. Every test above ran on
~5.5 months. Fixed: page funding at 500/call to `intervals`, and page the 8h
klines back to cover the full funding span (a single 1000-kline call only covered
~333 days, so older funding rows were nearest-mapped to recent prices — a
silent look-back-window mismatch). Now pulls the requested ~2 years. **Both
verdicts below were re-run on the deep data — the fix did not rescue either.**

## 2026-07-24 — funding carry (deep re-run) — **REJECT** (robust)

2000 × 8h (2024-09-26 → 2026-07-24). Healthier regime than the 5.5-mo window:
mean funding **0.469 bps/8h (~5.1%/yr), only 17.8% negative**. Still REJECT — all
Sharpes 0.00 (entry threshold keeps the delta-neutral book near-flat), though PBO
improved to 0.12. On two full years the carry-as-configured still does not clear
the ~12 bps/turn both-leg costs + hedge drag. Corroborates the firm's dormant-carry
finding on a longer, higher-funding sample.

## 2026-07-24 — funding-extreme directional fade (Backlog #3) — **REJECT (with a pulse)**

2000 × 8h. DIRECTIONAL (P&L = position × spot return, single-leg costs). Best
params lookback=10, entry_z=2.0.

- **Real structure exists:** shuffle p=0.005 and rotation p=0.015 (significant vs
  BOTH nulls — the timing is not luck), PBO 0.18 (low — not just grid-overfit),
  walk-forward OOS Sharpe +1.38.
- **But it fails out of sample:** locked holdout Sharpe **−1.52**, Deflated Sharpe
  0.63 (below bar), plateau 0.47 (fail). → **REJECT.**
- **Honest read:** strongly REGIME-DEPENDENT — regime Sharpe hi/lo = **1.94 / 0.13**
  (works in high vol, dead in low vol). The holdout landed in a regime where fading
  crowded longs = fighting a real trend, so it inverted. This is the same
  regime-conditional trap FirmTree's router just failed on (2026-07-23); a naive
  always-on fade can't harvest a regime-gated effect, and adding a regime gate is
  exactly the multiplicity/conjunctive risk we do NOT act on off one look. Logged as
  a candidate to REVISIT with a pre-registered regime split, not a build.

**Batch takeaway (2 real ideas, 0 survivors):** the gauntlet is doing its job —
carry has no gross edge over costs, fade has real but regime-conditional structure
that dies on the holdout. Neither is tuned-to-pass. Mortality is the point.

## 2026-07-24 — BREADTH BATCH (3 independent mechanisms) — 0 survivors

Built `examples/run_breadth.py`: the edge-STACKING sourcing loop (a registry of
diverse strategies → strict gauntlet → survivor scoreboard; ≥2 uncorrelated
survivors would feed build_portfolio). Ran 3 deliberately-independent, low-DOF
mechanisms on 5y REAL daily BTC (2021-07-26 → 2026-07-24, 1825 bars):

| idea | category | OOS | holdout | DSR | PBO | rot p | verdict |
|---|---|---|---|---|---|---|---|
| tsmom | trend | 0.87 | 0.70 | 0.80 | 0.75 | 0.095 | REJECT |
| reversal | reversal | 0.20 | −1.29 | 0.40 | 0.01 | 0.095 | REJECT |
| weekend_reversion | calendar | 0.34 | 0.61 | 0.77 | 0.14 | 0.065 | REJECT |

Honest reads: **tsmom** has positive OOS+holdout (~0.7–0.9) — a real-ish weak
momentum — but PBO 0.75 (overfit across the lookback grid) and rotation p=0.095
(not significant vs the autocorr-preserving null). **reversal** dies on holdout
(−1.29); short-term daily MR is negative in-sample-recent. **weekend_reversion**
is the faintest pulse: positive OOS+holdout, low PBO 0.14, but just misses on
DSR and rotation p=0.065. Two have positive holdouts but none clears the bar —
correctly. Nothing tuned to pass.

**Running scoreboard — 5 real ideas, 0 survivors, 0 stackable.** The stacking
thesis is right and the engine is built; it is downstream of finding survivors,
and the gauntlet has (correctly) passed none. The cheap single-asset corners
(carry/momentum/reversal/calendar) are the most-arbitraged, lowest-alpha parts
of crypto; higher-potential edges (cross-sectional, cross-venue dislocation,
liquidation-cascade, on-chain flow) need multi-asset/microstructure plumbing the
single-asset gauntlet doesn't yet have.

## 2026-07-24 — CROSS-SECTIONAL ALT batch (6 variants) — 0 survivors, but a REAL decayed edge

`examples/run_xsec.py`: adapter that runs a dollar-neutral top/bottom-tercile
long-short alt basket (20 coins, daily rebalance, 7bps/turn charged) through the
gauntlet as a pre-specified return stream. 5y real Binance daily.

| variant | ann% | OOS | holdout | DSR | verdict |
|---|---|---|---|---|---|
| xsec_mom_30 | +22.2 | 0.83 | −1.26 | 0.96 | REJECT |
| xsec_mom_60 | +8.8 | 0.35 | +0.02 | 0.70 | REJECT |
| xsec_mom_90 | +11.3 | 0.49 | −0.82 | 0.86 | REJECT |
| xsec_rev_3/7/14 | −63 to −73 | <0 | <0 | ~0 | REJECT |

**The finding:** cross-sectional alt MOMENTUM was a genuinely strong edge —
Sharpe **1.51 / 1.48 / 1.19 in 2021 / 2022 / 2023** — then decayed to flat
(2024–25) and **inverted to −2.51 Sharpe (−79%) in 2026**. The gauntlet's
holdout is 2026, so it correctly rejected a DECAYED edge (a naive full-sample
backtest shows +22%/yr and looks tradeable). Reversal being strongly negative
across the whole sample CONFIRMS momentum was the right direction — the alt
cross-section trends, it doesn't revert (until the 2026 regime flip).

**Adapter caveat (honest):** the constant-position fit neutralizes the gauntlet's
shuffle/rotation timing-nulls (Sharpe is permutation-invariant with a flat
position), so those printed 1.000 and carry no weight here; the verdict rests on
holdout / OOS / DSR / cost-stress / regime, which remain valid. A weight-matrix-
aware null would be the proper upgrade.

**WATCH, not dead:** cross-sectional alt momentum is a real regime-conditional
edge that reactivates in alt-cycle/dispersion regimes. Re-test if a new alt
season appears; do NOT trade it now (it is currently inverted).

## Session synthesis — 11 real ideas, 0 survivors, ONE coherent reason

Carry (dormant), funding-fade (regime-conditional), tsmom (weak/overfit),
reversal (negative), weekend (faint), xsec-momentum (real but decayed/inverted),
xsec-reversal (anti-edge). The recurring theme is not "no edges exist" — it is
that **every edge is REGIME-CONDITIONAL and they share a hidden driver (crypto
risk-appetite / beta regime).** That means they are NOT independent: naively
stacked, they are the same bet in different clothes and fail together in the same
regime. The stack-many-edges thesis is right, but the edges must be regime-
ORTHOGONAL (market-neutral microstructure, cross-venue funding dislocation,
settlement-timestamp flow) — not more facets of crypto beta. That is where the
machine should point next.
