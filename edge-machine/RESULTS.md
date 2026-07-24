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
