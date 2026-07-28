# London → New York: does the session direction continue?

**Question (from Lewis):** From the London open, the market picks a direction. How
often does that direction *keep going* through the New York open that follows —
i.e. what's the probability the move continues to trend up (or down), and how do
we trade it?

**Short answer:** Much less reliably than the folklore says. At the New York
*close* the London direction continues only about **50–53 %** of the time — a
coin flip with a small long-side tilt. In the **first 1–2 hours after the NY open
it actually reverses slightly more often than it continues** (the "NY-open
trap"). The only genuinely robust, exploitable fact is a **long-bias
asymmetry**: buying the NY-open dip after a *down* London session works (~54 %),
while shorting a strong *up* London session into NY does not. Every edge here is
small enough that trading costs decide whether it's positive — so this belongs
in your toolkit as a **filter / context**, not as a standalone signal.

---

## 1. Data & method

| | |
|---|---|
| **Instrument** | BTC/USD, 1-minute candles (Bitstamp, continuous) |
| **Source** | `ff137/bitstamp-btcusd-minute-data` (public) — 6.85 M minutes |
| **Span** | Jan 2012 → Jan 2025 · 3,329 weekday sessions |
| **Detailed window** | 2019 → 2025 (n = 1,570) — the regime that resembles today |
| **Sessions (UTC)** | London-led window **07:00 → 12:00**, New York window **12:00 → 20:00** |
| **London direction `D`** | sign of (price @ NY-open − price @ London-open) |
| **Continuation** | did the NY window keep moving the same way as `D`? |

Weekdays only (session effects are driven by traditional-finance desks, which are
closed on weekends). Every headline number was re-run on a **second session
definition** — London 08:00 / NY 13:00–21:00 — to make sure it survives the
daylight-saving smear (London/NY wall-clock opens drift ±1 h across the year).
Findings that flipped between the two definitions are flagged as *not robust*.

> **Why BTC and not SOL?** BTC has the longest clean intraday history and SOL
> trades as a high-beta amplifier of the same TradFi-session flows, so the
> *structure* is the same — SOL just moves ~1.5–2× as far. Re-run the script on a
> SOL hourly file to confirm; expect the same shape with bigger numbers.

---

## 2. At the NY *close*, continuation is a coin flip

| Era | Continue | after **UP** London | after **DOWN** London | base P(NY up) |
|---|---|---|---|---|
| All years (2012–25) | **49.2 %** | 55.0 % | 43.8 % | 55.3 % |
| **2019+** | **52.7 %** (z = 2.1) | 54.4 % | 51.0 % | 51.7 % |
| 2021+ | **53.0 %** | 52.6 % | 53.5 % | 49.7 % |

Read this carefully:

- Over the **full history the London direction did *not* continue** (49 %). The
  reason is entirely the down-side: after an UP London, NY continued 55 % of the
  time; after a DOWN London, it continued only **44 %** (i.e. down-moves reversed
  56 % of the time). That's BTC's structural uptrend, not a session effect.
- In the **modern era it's ~53 %** — a real but tiny edge, and most of it is just
  the market drifting up (`base P(NY up)` ≈ 51–55 %). Strip out the drift and
  "London sets the direction NY follows" is worth **≈ 1–2 percentage points**.

**Takeaway:** the plain "London went up so NY keeps going up" idea is *barely*
better than a coin toss, and it was a *losing* assumption on the short side for
most of BTC's history.

---

## 3. The intraday shape: fade early, reassert late

Continuation isn't flat across the NY session — it has a distinct **U-shape**.
P(price still in London's direction) measured at NY-open + *k* hours, 2019+:

| Exit | +1h | +2h | +3h | +4h | +5h | +6h | +7h | +8h |
|---|---|---|---|---|---|---|---|---|
| Continue | 48.7 % | **47.5 %** | 50.0 % | 50.3 % | 50.4 % | 51.5 % | **53.2 %** | 52.7 % |
| z vs 50 % | −1.1 | **−2.0** | 0.0 | 0.2 | 0.3 | 1.2 | **+2.5** | +2.1 |

- **First 1–2 hours after the NY open → the London move fades.** Continuation
  drops *below* 50 % (47.5 % at +2h, z = −2.0 — statistically significant). On the
  alternate 08:00/13:00 definition this is even stronger (45.8 % at +1h, z = −3.3).
  This is the classic **"NY-open trap" / Judas swing**: the first US reaction
  often runs the London move's stops before the day's real trend resumes.
- **Late US session (into ~19:00–20:00 UTC) → the London direction reasserts**
  (~53 %, z = 2.5). The move that fades at the open tends to come back by the US
  afternoon.

This U-shape is the single most useful *structural* fact in the whole study, and
it holds on both session definitions.

---

## 3b. When does it turn — and is it the same time each day?

Short answer: **yes, roughly — the turn clusters at the US cash open (~13:00–14:00
UTC ≈ 09:30 New York), and up-days and down-days turn at about the same time.**
But it's an hour-wide *window*, not a set-your-watch minute.

Two ways to see it:

- **Where the fade bottoms (win-rate).** The share of days offside vs London is
  greatest in the first 1–2 h after the NY open (continuation troughs 47.5 % at
  +2h). The trough clock-time barely moves when you shift the London definition —
  both the 07:00 and 08:00 clocks bottom around **13:00–14:00 UTC** — which is why
  it looks *clock-anchored to the US open* rather than tied to "N hours after
  London."
- **The average price path (artifact-free).** Direction-adjusted mean move vs the
  NY-open price, per 30 min (2019+):

  | UTC | 12:00 | 12:30 | 13:30 | 14:00 | 15:00 | 16:30 | 18:00 | 19:30 |
  |---|---|---|---|---|---|---|---|---|
  | mean move | +0.01 % | +0.03 % | +0.04 % | +0.06 % | +0.06 % | +0.09 % | +0.10 % | **+0.11 %** |

  The *mean* dips only marginally at the open (the fade is a lot of small red days,
  not a big average drop) and then **grinds in London's direction all afternoon**,
  strongest into the US close (~19:00–20:00 UTC). So the picture isn't a symmetric
  V that rolls back over — it's **"small shake-out near the US open, then trend
  into the close."**

**Symmetry.** Up-days (turn = the NY low) and down-days (turn = the NY high) reach
that counter-extreme at essentially the same clock: median **14.2 vs 14.8 UTC**.
The *mechanism* is mirror-image; only the *reliability* is asymmetric (the long
side is better, per §5).

**Is there a precise "it turns now" trigger? No.** Per-day turn times are spread
across the US morning, and the popular *stop-run* tell — the counter-move first
sweeping the London high/low — happens on only **37 %** of days and, when it does,
the London direction resumes **75.6 %** of the time vs **78.7 %** on non-sweep days.
i.e. the sweep is a common *entry location*, not a predictive signal. **The clock
(US open) is the indication; there is no magic per-candle tell.**

**How to use it:** treat **~13:00–14:30 UTC (09:00–10:30 New York)** as the window
where the early fade exhausts and London's direction tends to resume. Let that
shake-out happen, position in London's direction *after* it, and hold toward the
US close where continuation is strongest — rather than chasing at the open.

---

## 4. The honesty check: a >50 % win rate here is *not* free money

Winning slightly more than half the time only pays if your winners aren't smaller
than your losers. They are. Gross expectancy, enter at NY-open, exit +*k*h, 2019+:

| Exit | FOLLOW win / avg / PF | FADE win / avg / PF | fade avg win / avg loss |
|---|---|---|---|
| +1h | 48.7 % / +0.03 % / 1.17 | 51.2 % / −0.03 % / 0.85 | +0.37 % / −0.45 % |
| +2h | 47.5 % / +0.04 % / 1.13 | 52.4 % / −0.04 % / 0.89 | +0.54 % / −0.67 % |
| +8h | 52.7 % / +0.11 % / 1.16 | 47.3 % / −0.11 % / 0.86 | +1.46 % / −1.52 % |

The fade wins *more often* but each winner is *smaller* than each loser (mean
reversion: you clip small gains, then a trend day runs you over). Net result:
**profit factors sit around 0.85–1.19 and the average per-trade edge is
±0.03–0.11 %.** Worse, the *sign* of that tiny edge flips between the two session
definitions (on 08:00/13:00 the +1h FADE is PF 1.10 while FOLLOW is 0.91 — the
mirror image of the table above).

**Conclusion:** neither "fade the open" nor "follow London" is a standalone,
robustly profitable strategy. With crypto round-trip costs of ~**0.05–0.10 %**
(taker fee + spread), a 0.03–0.11 % gross edge is break-even at best. **Costs are
the boss here.**

---

## 5. The one robust asymmetry: buy weakness, don't sell strength

Split the NY-open fade by which way London went (2019+, exit +2h). This *is*
robust across both session definitions:

| Setup | cfg 07:00/12:00 | cfg 08:00/13:00 |
|---|---|---|
| London **DOWN** → **buy** the NY open | win 53.5 %, PF **1.04** | win 55.6 %, PF **1.08** |
| London **UP** → **short** the NY open | win 51.3 %, PF 0.75 | win 50.2 %, PF 0.90 |

Buying the dip after a red London session pays; shorting the rip after a green one
doesn't. It's the same long-bias that shows up everywhere in BTC — **mean-revert
the downside, respect the upside.** If you take only one mechanical idea from this
study, it's this one.

## 5b. Filters that nudge *follow-through* higher

For continuation (trend) trades rather than fades, two filters lift the net-close
hit rate — modestly, and somewhat config-dependent:

| Filter (2019+) | Continue | follow PF |
|---|---|---|
| London dir **aligned** with 20-day trend | 52–54 % | 1.06–1.22 |
| aligned **+** London push ≥ 0.5 % | **53–55 %** | 1.16–1.30 |
| against trend | 50–52 % | 1.07–1.11 |

A London move that (a) agrees with the higher-timeframe trend and (b) is a decent
size (≥ 0.5 %) is the best "follow" context — but note it slipped from 55 %/PF 1.30
to 53 %/PF 1.16 on the alternate session clock, so treat 55 % as the optimistic
end.

---

## 5c. Timing the entry: which trigger?

If the resumption clusters at the US open, can a *trigger* beat simply entering at
the open? I tested several (BTC 2019+, enter in London's direction, scored both
held-to-close and on a fixed 1 %/2 % bracket — `triggers.mjs`):

| Trigger (all days) | Fires | Win (to close) | Avg | PF | Median entry |
|---|---|---|---|---|---|
| enter @ NY open *(baseline)* | 100 % | 52.5 % | +0.11 % | 1.16 | 12:00 |
| VWAP reclaim | 99 % | 52.1 % | +0.09 % | 1.13 | 12:31 |
| NY-open reclaim | 87 % | 51.8 % | +0.10 % | 1.16 | 12:33 |
| Opening-range break (NY / US) | ~80 % | ~49 % | +0.02 % | 1.03 | 13:00–14:20 |
| **London sweep + reclaim** | **37 %** | **52.6 %** | **+0.17 %** | **1.30** | **14:27** |

- **Momentum / breakout triggers don't help.** VWAP-reclaim and NY-open-reclaim ≈
  the baseline; opening-range breakouts are *worse* (you buy the high).
- **Only sweep + reclaim beats it:** let price run the London high/low (a stop
  grab), wait for it to close back inside the range, and enter on that reclaim.
  It's selective (37 % of days) and its median entry — **14:27 UTC** — lands
  squarely in the US-open window §3b flagged.

Traded the natural way — structural stop just beyond the swept wick, let winners
run to the close (2019+, median 1R ≈ 0.33 %; `sweep-reclaim.mjs`):

| Sweep + reclaim, stop→close | Trades | Win | Avg R | PF |
|---|---|---|---|---|
| All | 568 | 26 % | +0.46 | 1.64 |
| **SELL after a red London** (D<0) | **291** | **29 %** | **+0.74** | **2.08** |
| Buy after a green London (D>0) | 277 | 23 % | +0.16 | 1.21 |

> **Direction — read carefully.** We enter *with* London's direction on the reclaim,
> so a **red/down London day is a SHORT** (price sweeps the London *high*, fails, and
> resumes down) and a green day is a long. This is a *different, later* trade from the
> §5 fade (which *buys* the early NY-open dip) — don't conflate them.

The **sell/red side is the one with the edge** (PF 2.08); the buy/green side is weak
(1.21). But be honest about the shape — it's **lumpy and year-dependent**. Per-year
avgR on the sell side is +0.09 / +0.27 / **+2.16** / −0.09 / +0.71 / **+1.69**
(2019→2024): positive in 5 of 6 years but *carried by 2021 and 2024*, and 2022 was
its worst. Treat "PF 2" as a fat-tailed average, not a steady wage.

**Caveats that bite here:** the stop is tight (~0.33 % = 1R), so a ~0.05–0.10 %
round-trip cost is **0.15–0.30 R** — the *all* set gets thin after fees, the *sell/red*
set keeps room. The fat right tail leans on trend days, so expect droughts and
occasional big winners, not a smooth curve.

**Bottom line on triggers:** there is no per-candle "it turns now" signal. The
tradeable structure is *sweep of the London range near the US open → reclaim →
enter with London's direction (the sell/red side has the edge) → stop beyond the wick
→ manage the exit (see §5e).*

---

## 5d. Does high participation concentrate the edge? (volume filter)

Prior art (Gao et al.'s intraday-momentum result; Zarattini's "stocks in play")
predicts the edge should live on **high-participation days**. Testing that on the
sweep + reclaim with a **relative-volume filter** — opening-window (12:00–13:30 UTC)
volume vs its trailing-20-day median, known before the ~14:30 entry
(`sweep-reclaim.mjs`, stop→close in R):

| Subset | n | Win | Avg R | PF |
|---|---|---|---|---|
| baseline (all) | 568 | 26 % | +0.46 | 1.64 |
| **RVol ≥ 1.2× (high volume)** | 175 | 32 % | +0.78 | **2.21** |
| RVol 0.8–1.2× | 133 | 26 % | +0.22 | 1.30 |
| RVol < 0.8× (quiet) | 254 | 23 % | +0.39 | 1.52 |
| **Sell/red + RVol ≥ 1.2×** | 90 | 33 % | +0.81 | **2.30** |

**Prediction confirmed:** high relative-volume days lift the edge — PF 1.64 → 2.21
(all), sell/red side 2.08 → 2.30, win rate up to 33 %. Best clean filter = *the
sell/red side on a high-volume day.*

Two honest wrinkles:
- **Volume helps; raw range doesn't.** A range-expansion filter (wide opening
  range) *hurts* — PF 1.13 vs 1.85 for narrow-range days — because wide-range days
  are trend/expansion days where the fade gets run over. We want a **liquid but
  not-yet-exploded** day: high volume, *normal* range. (For a *reversal* setup it's
  the liquidity that pays, not the volatility — a refinement of Gao's "volatile days".)
- **NFP-proxy days** (first Friday, 8:30 ET jobs release) win 36 % but n = 28 —
  suggestive, underpowered. A real econ calendar via `NEWS_CSV=…` would test
  FOMC/CPI/NFP properly; the hook is built into the script.

Caveats: filtered samples are smaller (n ≈ 90 for sell/red + high-vol, ~15/yr) so
guard against overfitting — though the lift matches theory, which lends credibility.
1R is still ~0.33 %, so costs remain a real bite. RVol uses only pre-entry data
(trailing median + opening window before the typical entry).

---

## 5e. The win rate is a dial (the exit, not the entry)

A ~29 % win rate isn't a weak edge — it's the **exit** we chose (*hold to close*),
which maximises the average winner at the cost of win rate. On the *same* entries
(sell/red side, n = 291), swapping the exit walks you along a win-rate/reward curve
(`exit-lab.mjs`, gross, 2019+):

| Exit policy | Win | No-loss | Avg R | PF |
|---|---|---|---|---|
| Hold to close *(current)* | 29 % | 29 % | +0.74 | 2.08 |
| Target 1R | **58 %** | 58 % | +0.16 | 1.41 |
| Target 1.5R | 50 % | 50 % | +0.22 | 1.45 |
| **Scale ½ off at +1R, rest runs** | **58 %** | 58 % | +0.40 | 2.01 |
| **Stop → breakeven after +1R** | 20 % | **58 %** | +0.64 | **2.61** |

- **A fixed 1R target doubles the win rate (29 % → 58 %)** — but the average winner
  shrinks from +0.74R to +0.16R and total expectancy falls. You didn't improve the
  edge, you *moved along the curve.*
- **Scale ½ off at +1R** is the sweet spot: ~58 % win *and* PF ~2.0 — you bank a
  winner more than half the time while the other half keeps the fat tail.
- **Stop → breakeven after +1R** takes a full loss only ~42 % of the time (58 %
  no-loss) and keeps almost all the expectancy (PF 2.61) — best if it's the *losing*
  that's hard to sit through.

The lesson generalises: **win rate and average winner trade off; pick the point that
matches your temperament, not the highest number.** A higher win rate here does not
mean a better system — often a worse one after costs (target-1R nets ~+0.05 %/trade
gross, barely above fees; hold-to-close and scale-out keep more).

---

## 6. Volatility, for sizing (2019+)

| Metric | Mean | Median |
|---|---|---|
| NY session high–low range | 3.2 % | 2.6 % |
| \|net NY open→close move\| | 1.5 % | 1.0 % |
| London move into the NY open | 0.9 % | — |

So a typical NY session travels ~2.6 % top-to-bottom and closes ~1 % from its
open. Size stops/targets off that: a ~1.3–1.8 % stop is roughly 0.5–0.7× the
median range (survives normal noise), with a 1–1.5× target.

---

## 7. How to trade it — the playbook

**Don't:**
- ❌ Blindly buy/sell the NY open just because London ran that way. Into the first
  1–2 hours that's a *below-50 %* bet.
- ❌ Short a strong up-London into the NY open. Negative expectancy (PF 0.75–0.90).
- ❌ Treat any of this as a mechanical money-printer. The gross edges are ~½ a
  typical round-trip fee.

**Do (highest-confidence first):**
1. **Sell the sweep-and-reclaim after a *red* London** (see §5c) — the sharpest
   mechanical setup (note: it's a **short**, entering *with* the down-London
   direction). Near the US open (~13:00–14:30 UTC) let price run *above* the London
   high and *reclaim* back below it, then go short; stop just above the swept wick
   (~0.3–0.5 %). **Filter to high relative-volume days** (opening volume ≥ ~1.2× its
   20-day norm) — lifts PF ~2.1 → ~2.3 (§5d); skip wide-range/trend days. Manage the
   exit to taste (§5e): hold-to-close for max expectancy (~29 % win), or **scale ½
   off at +1R** for a ~58 % win while keeping PF ~2.0. Caveat: the edge is lumpy
   (carried by 2021 & 2024) and it's a short in a long-biased asset — size small.
2. **Expect the NY-open trap.** If you *want* to trade London's direction, don't
   chase the open — wait out the first 1–2 h and enter the pullback; the move
   tends to reassert into the US afternoon (~53 % by 19:00 UTC).
3. **Use London→NY as a *confluence filter*, not a trigger.** Best continuation
   context = London direction **aligned with the 20-day trend** *and* a **≥ 0.5 %**
   London push. Take your normal setups only when they line up with that.
4. **Mind the clock (DST).** "London open" is 07:00 UTC in winter, 08:00 UTC in
   summer. The effects survive the shift but are an hour earlier/later — anchor to
   *London local* 08:00 and *New York local* 09:30 rather than a fixed UTC hour.
5. **Only trade the filtered setups**, and prefer maker fills / tight-spread
   venues. At a ~0.05 % gross edge, frequency and fees, not direction, decide P&L.

---

## 8. Caveats

- **Costs excluded.** All P&L is gross. After ~0.05–0.10 % round-trip, the naive
  versions are break-even-to-negative; only the filtered setups plausibly survive.
- **No path/intrabar modelling.** Continuation is measured on hourly closes, not
  on whether a stop would have been hit first. A real backtest with stops/targets
  is the next step (the script exposes the per-day highs/lows to build one).
- **One instrument, one venue.** BTC/Bitstamp. Re-run on BTCUSDT/SOLUSDT (Binance,
  your live venue) before sizing real risk — see the reproduction steps below.
- **Regime-dependent.** Per-year continuation swings from 45 % (2013–18) to 57 %
  (2019). This is a soft, drifting tendency, not a constant.

---

## 9. Reproduce / extend

The analysis is one dependency-free script — see
[`research/session-direction/`](../../research/session-direction/).

```bash
# 1. get an hourly (or minute) OHLCV CSV for your symbol
node research/session-direction/fetch-hourly.js BTCUSDT   # writes BTCUSDT-1h.csv
node research/session-direction/fetch-hourly.js SOLUSDT

# 2. run the study (session hours overridable via env)
node research/session-direction/analyze.mjs BTCUSDT-1h.csv
L_OPEN=8 NY_OPEN=13 NY_END=21 node research/session-direction/analyze.mjs SOLUSDT-1h.csv

# 3. entry-trigger research (needs 1-minute data with a volume column)
node research/session-direction/triggers.mjs      btcusd_1min.csv.gz   # compare triggers
node research/session-direction/sweep-reclaim.mjs btcusd_1min.csv.gz   # deep-dive the winner
```

Everything above was produced by the same script; the raw output is committed as
`session-direction-results.json`.
