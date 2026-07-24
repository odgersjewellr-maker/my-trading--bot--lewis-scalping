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
