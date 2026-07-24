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

## 2026-07-24 — cross-venue funding dislocation (#6, Binance vs Bybit) — REJECT (decisive)

`examples/run_xvenue_carry.py`: the regime-ORTHOGONAL idea — an arb on the
funding SPREAD (short richer venue's perp / long cheaper), price-neutral. Reuses
carry_asset_return with spread as "funding", inter-venue divergence as "basis".
1135 × 8h aligned (2024-09-26 → 2026-07-24).

**Caught a data bug first (honesty ethos):** initial run showed divergence MTM
vol 141.5 bps/interval — impossible for two BTC perps. Cause: Bybit 4h-kline
CLOSE is the price 4h after its label, sampled 4h off Binance's price → raw BTC
move injected as fake divergence. Fixed by sampling both venues' 4h-kline OPEN at
the settlement instant; divergence fell to a sane 1.6 bps/interval.

**Clean verdict:** REJECT, decisively. Spread mean **−0.016 bps/8h ≈ 0** — the two
largest venues arbitrage BTC funding flat. Trading the 0.57 bps transient std
against 14 bps/turn costs loses (in-sample Sharpe −3.69, OOS −2.30, 2x-cost
−3.97). The dislocation edge, if any, lives in LESS-liquid alts / less-arbitraged
venue pairs — not BTC on the two biggest venues.

## Session map — 12 real ideas, 0 survivors, the accessible space is EFFICIENT

Directional edges (carry/fade/momentum/reversal/weekend/xsec) are all
REGIME-CONDITIONAL and share the crypto-beta regime driver → not independent,
fail together. The one structurally regime-ORTHOGONAL idea (cross-venue arb) is
ARBITRAGED FLAT on liquid BTC. Conclusion: **liquid crypto with daily/8h public
data is efficient** — no easily-accessible stackable edge exists here. The
machine is working perfectly (12 clean rejects, caught a decayed edge in 2021-23
alt momentum, caught 2 of its own data bugs). Trading nothing beats trading
noise. Harder-to-reach frontiers remain (illiquid alts; higher-frequency
microstructure via the orderflow-depth data; the futures/prop domain where the
firm's NQ opening-window survivor already lives) — but the daily-public-crypto
edge hunt has been fairly mapped, and it is picked clean.

## 2026-07-25 — MICROSTRUCTURE / order-flow (first rung, 15m kline-delta) — 0 survivors

`examples/run_micro.py`: aggressor flow WITHOUT tick data — Binance futures klines
carry per-bar taker-buy volume, so delta = 2·taker_buy − vol and CVD = cumsum(delta).
The Valentini/Rosato absorption primitive, quantified. 35,000 × 15m real BTC-perp
(2025-07-25 → 2026-07-24).

| idea | kind | IS | OOS | holdout | DSR | 2x-cost | rot p | verdict |
|---|---|---|---|---|---|---|---|---|
| delta_mom | momentum | −6.12 | −6.09 | −6.98 | 0.00 | −12.58 | 0.270 | REJECT |
| absorb_fade | reversal | +0.26 | −0.73 | +0.92 | 0.17 | −1.34 | 0.010 | REJECT |

**delta momentum is decisively DEAD** — chasing aggressor flow at 15m loses badly
(−6 Sharpe everywhere): the flow is not persistent/informed at this resolution,
and costs bury it. **absorption fade has a FAINT REAL PULSE** — positive holdout
(+0.92) and rotation p=0.010 (significant vs the autocorrelation-preserving null,
i.e. genuine timing structure) — Valentini's "absorbed aggression reverts" is a
real effect. **But it is sub-cost:** OOS −0.73 at 1× and −1.34 at 2× cost. The
Law-2 wall kills it.

## THE universal finding — every real crypto edge is thin, and thin dies to taker costs

Across IVB (5 tests), carry, fade, momentum, reversal, cross-sectional,
cross-venue, and now order-flow: wherever a REAL effect appears (2021-23 alt
momentum; funding fade in high-vol; absorption reversal), it is **too thin to
clear taker costs.** Law 2 is the single universal killer, in every domain. The
implication is decisive and useful: **the lever is EXECUTION, not signal.** No
bigger signal is hiding; the question for any real-but-thin edge is whether MAKER
execution (or a lower-frequency hold) drops the cost bar under the edge. The firm
already measured that maker cuts the bar ~3.5× (IVB maker test) — but IVB had no
gross edge to rescue. Absorption is the first candidate with BOTH a (faint) gross
pulse AND the maker cost-lever available. That, plus the forward-only 1m/L2
resolution (orderflow-depth collector), is the only crypto thread left worth
pulling — and it is a forward-test infrastructure project, not another backtest.

## 2026-07-25 — absorption fade (inverted flow-watcher) — KILL — and a CORRECTION

Pre-registered/frozen (`be53d4b`) BEFORE results, then run: 8 daily 6h SOL
aggTrade windows, honest adverse-selection maker fills, real Binance fees.

**This corrects an over-claim.** An earlier scratchpad look reported the absorption
fade as "the first cost-clearing signal" (+0.45 bp/trade net) — WRONG, on two
counts, both now fixed: (1) it used ~10× too-low fees (0.4 bp maker RT vs the real
~4 bp), and (2) it filled the maker entry cleanly with NO adverse selection.

**Honest result:** with adverse-selection fills — you rest a limit past the spike
and fill ONLY when price trades through you (the continuation = the bad entry),
missing the reversals (the easy wins) — the **GROSS edge flips NEGATIVE: −1.57 bp,
46% win.** Adverse selection alone kills it, before fees. Net: −9.57 bp @ real
8 bp RT, −5.57 bp even @ maker-both 4 bp best case; holdout Sharpe negative both
ways. Per-window gross is pure noise (+17, −10, +5, −2.8 …). **VERDICT: KILL.**

**Why it matters:** being the passive absorber means you are ADVERSELY SELECTED —
you get filled precisely on the trades that run against you, not the ones that
reverse. That is the deep reason non-colocated retail cannot market-make crypto
microstructure. The "maker lever" is not free: the maker IS the adversely-selected
counterparty. So the one lead with a gross pulse + a cost lever dies to a SECOND
universal killer beyond Law-2 costs.

## FINAL — 15 real ideas, 0 survivors, the crypto edge hunt is honestly complete

Carry, fade, tsmom, reversal, weekend, cross-sectional (×6), cross-venue, order-
flow momentum, order-flow absorption. Every real effect found is thin and dies to
taker costs (Law 2); the one that had a gross pulse + maker lever (absorption)
dies to adverse selection on the maker fill. The accessible crypto edge space —
liquid names, public data, retail execution — is efficient. The machine worked
perfectly: 15 clean rejections, a decayed edge caught, 2 data bugs caught, and one
FALSE POSITIVE (this one, from sloppy scratchpad assumptions) caught and corrected
by its own pre-registered discipline. That last catch is the point of the whole
machine. Firm edge lives elsewhere (NQ opening-window futures survivor). The Edge
Machine's standing value is as an honest rejection/monitoring engine.
