# Prior art: what our sweep + reclaim already has a name (and what to borrow)

Our best setup — *London sets a bias → NY open sweeps the London range (stop run) →
price reclaims → resume the bias, long-side, risk in R* — is not new. The same
structure has been described independently for ~90 years. That's reassuring (it's a
real, persistent liquidity mechanic, not a curve-fit) **and** useful: each tradition
has already worked out rules and filters we can lift.

## The family tree

| Source | Era | Their name for our thing | What to borrow |
|---|---|---|---|
| **Wyckoff** — *spring / upthrust* | 1930s | Spring: false break below support, stops swept & absorbed, then markup. Upthrust = mirror. | The **volume read**: a genuine spring sweeps on a volume spike, then the *reclaim/test happens on lower volume* (supply exhausted). Add volume conditions to the sweep. |
| **Raschke & Connors** — *Turtle Soup* (*Street Smarts*, 1996) | 1990s | Published rule-based **false-breakout reversal**. | Concrete template: the swept level should be a **significant prior extreme** (they use a 20-period low aged ≥ 4 bars), enter opposite the failed break, **tight stop just beyond the extreme**, take profit reasonably fast. A "Plus-One" variant waits one bar for confirmation. |
| **Market Profile** — Dalton, *Mind Over Markets* | 1980s–90s | **Initial Balance** (first hour range) + **"open-rejection-reverse"** open type. | Classify the day: is the NY open *rejecting* the initial move (our setup) or *driving* (trend day — stand aside)? IB break vs IB failure as context. |
| **ICT / Smart-Money Concepts** — *Judas Swing, killzones, Silver Bullet* | 2010s (retail) | NY killzone 07:00–10:00 ET (= 12:00–15:00 UTC, **our window**); "liquidity sweep of the London high/low at the NY open"; Silver Bullet 10:00–11:00 ET entry. | The **timing windows** and a **confirmation rule**: wait for a *market-structure shift* + first fair-value-gap after the sweep before entering. Our median entry (14:27 UTC) already lands in the Silver Bullet window. *(Treat the guru claims skeptically — see evidence note.)* |
| **Gao, Han, Li & Zhou** — *Market Intraday Momentum* (JFE, 2018) | Academic | First half-hour return predicts the **last** half-hour return. | Peer-reviewed proof that time-of-day predictability is real — and, crucially, **it concentrates on high-volume, high-volatility, recession, and macro-news-release days.** This validates our "data-day" hypothesis. Borrow: the **volume/vol/news filter** and a **last-30-min (US-close) exit anchor**. |
| **Zarattini & Aziz** — *Can Day Trading Really Be Profitable?* (2023) + *A Profitable Day-Trading Strategy* (2024) | Academic-practitioner | 5-min **Opening-Range Breakout**, but only on **"stocks in play."** | Why our naive ORB failed and theirs works: a **Relative-Volume filter** (opening volume vs its 14-day average) + strict **R-multiple risk** with an EOD stop. The edge tracks relative volume, not the breakout itself. |

**The convergence.** Wyckoff (1930s), Raschke (1996), Dalton, ICT (2010s) and two
independent academic lines (2018, 2024) all land on the *same* claim: **the tradeable
event is a confirmed reversal after a liquidity sweep, it concentrates on
high-participation / news days, and it must be risk-managed in R.** We found the exact
same thing bottom-up in BTC. That agreement across very different methods is the
strongest evidence we have that it's structural.

## Borrowable refinements — a testable backlog

Ranked by expected value, each maps to a concrete change in `sweep-reclaim.mjs`:

1. **Relative-Volume / "day-in-play" filter** *(Zarattini + Gao — best evidence).*
   Only take the setup when NY-session (or opening 15–30 min) volume is elevated vs
   its 14–20-day average, and/or a scheduled US macro release exists (8:30 / 10:00 ET).
   *Prediction:* the edge concentrates on these days and is near-zero on quiet ones.
   We already carry volume in the data — this is the first test to run.
2. **Volume-confirmed sweep** *(Wyckoff).* Require the sweep to spike volume and the
   reclaim to occur on *lower* volume. Filters random pokes from genuine stop-runs.
3. **Sweep a *significant* level, not just the London low** *(Turtle Soup).* Test
   sweeping the **prior-day** or multi-day high/low (optionally aged ≥ a few sessions)
   vs the intraday London extreme alone. Bigger resting-liquidity pools → cleaner reversals.
4. **Structure-shift confirmation + Silver-Bullet window** *(ICT).* Require a micro
   break-of-structure after the sweep before entry, and weight the 14:00–15:00 UTC
   (10–11am ET) sub-window. Trades convenience of a mechanical entry for fewer false ones.
5. **Day-type gate** *(Market Profile).* Skip "open-drive" trend days (price never
   comes back to the open / IB) — those are where fading the sweep gets run over.
6. **R-model + vol-scaled sizing & US-close exit** *(Zarattini + Gao).* Keep the
   structural R stop; add fixed-fractional risk per trade, size inversely to ATR, and
   test an explicit **US cash-close** exit (20:00–21:00 UTC) vs kR targets.

## Evidence quality — read with the right skepticism

- **Peer-reviewed / rigorous:** Gao et al. (JFE); Zarattini et al. (data-driven, large
  samples, costs included). Also worth reading: Heston, Korajczyk & Sadka,
  *"Intraday Patterns in the Cross-Section of Stock Returns"* (J. Finance, 2010) on
  time-of-day periodicity. **Caveat:** these are US equities/ETFs, not crypto —
  transfer is plausible (same session/liquidity drivers, crypto trades US macro hours)
  but needs its own validation, which our BTC study partly provides.
- **Classic, credible, not academically validated:** Wyckoff and Raschke's Turtle Soup —
  decades of practitioner use; Raschke is a documented *Market Wizard*. Sound logic,
  no public rigorous backtest.
- **Useful vocabulary, heavy marketing — verify everything:** ICT / SMC. The
  descriptive terms (killzone, liquidity sweep, Judas swing) map genuinely onto real
  microstructure and gave us good timing windows, but the space is full of
  unfalsifiable "90% win-rate" claims and no rigorous public evidence. **Take the
  concepts and the clock; ignore the mystique; backtest before believing.**

## Sources

- ICT killzones / Silver Bullet / Judas swing — [innercircletrader.net](https://innercircletrader.net/tutorials/master-ict-kill-zones/), [ictkillzone.com](https://www.ictkillzone.com/ict-silver-bullet)
- Turtle Soup (Raschke & Connors, *Street Smarts* 1996) — [turtletrader.com/trader-raschke](https://www.turtletrader.com/trader-raschke/), [New Trader U](https://www.newtraderu.com/2020/08/15/turtle-soup-trading-strategy/)
- Wyckoff spring / upthrust — [Trading Wyckoff](https://tradingwyckoff.com/en/spring-shakeout/), [LiteFinance](https://www.litefinance.org/blog/for-professionals/wyckoff-method/)
- Gao, Han, Li & Zhou, *Market Intraday Momentum* — [SSRN 2440866](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2440866), [ScienceDirect (JFE)](https://www.sciencedirect.com/science/article/abs/pii/S0304405X18301351)
- Zarattini & Aziz, *Can Day Trading Really Be Profitable?* — [SSRN 4416622](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4416622); Zarattini, Barbon & Aziz, *A Profitable Day-Trading Strategy* — [SSRN 4729284](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4729284)
