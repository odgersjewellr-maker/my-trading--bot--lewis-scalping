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
1. **Long the NY-open dip after a down London** — the one robustly positive
   mechanical setup (~54 %). Best when price is still above its 20-day trend.
   Stop ~1.3–1.8 %, first target the London-open price / +1 %.
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
```

Everything above was produced by the same script; the raw output is committed as
`session-direction-results.json`.
