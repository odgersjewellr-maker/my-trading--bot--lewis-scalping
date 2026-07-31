# Daily Range Band Breakout (failed-breakout reversal)

A prior-range strategy: instead of a single previous-day high/low line,
the box is now a **band** built from the last two (or more) days' highs and
lows. Trade against breakouts that fail to hold, entered with a 2-bar
direction confirmation.

## Rules

1. **Band** — take the last `bandLookback` completed days (default 2):
   - upper band = `[min(H1,H2), max(H1,H2)]`
   - lower band = `[min(L1,L2), max(L1,L2)]`
   - **center** (the zone both days agree was "inside the range") =
     `[max(L1,L2), min(H1,H2)]`
   `bandLookback: 1` collapses this back to a single previous-day line on
   each side (the original design, kept as a comparison row in the output).
   `periodMode` still controls what a "period" means (`"day"` — the default
   again — or `"week"`).
2. **Breakout** — a candle *closes* beyond the **far edge** of a band
   (above `max(H1,H2)`, or below `min(L1,L2)`) — i.e. it has to clear both
   prior days' extremes, not just the nearer one. Price can stay outside for
   any number of candles; the stop is measured off the furthest point
   reached during the whole excursion. An excursion that never reclaims
   within `maxExcursionBars` is abandoned.
3. **No trading inside the band.** While price is sitting between the far
   edge and the near edge of a band — has broken out but hasn't gotten back
   to center — nothing happens. That ambiguous zone is exactly what a single
   noisy line used to treat as a hard yes/no; now it's a real buffer.
4. **Reclaim** — the first candle that *closes* back past the **near edge**
   of the band into the center (below `min(H1,H2)` for a short, above
   `max(L1,L2)` for a long) is the reclaim candle.
5. **Direction confirmation (`confirmBars`, default 2)** — starting from the
   reclaim candle, each subsequent candle has to close further in the
   trade's direction than the one before it. Entry fires once the count
   reaches `confirmBars`; a candle that closes the other way scraps the
   setup instead of getting chased. `confirmBars: 1` = enter right on the
   reclaim candle, for comparison.
6. **Stop** — beyond the excursion's extreme, plus an ATR buffer. **Target**
   — a fixed reward:risk multiple (2:1 default), or `exitMode: "rangeRun"`,
   which targets the near edge of the *opposite* band, optionally with a
   breakeven stop trail once price has moved `trailBreakevenAtR` in favor.

One trade per band per direction. Position sizing is risk-based (`riskPct`,
default 1% of portfolio per trade, sized off the actual stop distance).

## Files

| File | What it does |
|------|-------------|
| `daily-range-breakout.js` | Strategy logic + backtest engine. `node daily-range-breakout.js [csv] [--optimize]` |
| `fetch-binance-intraday.js` | Pulls intraday candles from Binance. Defaults to SOLUSDT 15m/180d — `node fetch-binance-intraday.js SOLUSDT 15m 180` or `... SOLUSDT 5m 90` |

## Confirmation filters, in priority order

1. **ADX regime filter** (`useADXFilter`, `adxMaxThreshold`, default 30) —
   still the filter I'd lead with. This is a counter-trend fade strategy by
   nature; it works range-bound and gets run over trending. Blocks entries
   while ADX shows a strongly trending market.
2. **Rejection wick filter** (`useRejectionWickFilter`, `rejectionWickFrac`,
   default 0.3) — new this round. Requires the candle that set the
   excursion's extreme to show a real wick beyond its body (a long upper
   wick for a failed upside breakout, long lower wick for a failed downside
   one) — not a strong-bodied continuation candle. This is straight out of
   classic price-action "liquidity grab" reading: the bar that tagged the
   extreme should look like rejection, not conviction.
3. **Fisher Transform** (`useFisherFilter`, `fisherPeriod`, default 9,
   `fisherFreshCross`) — Ehlers' turning-point oscillator; direction = the
   Fisher line vs. its own 1-bar-lagged trigger.
4. **2-pole Super Smoother** (`useTwoPoleFilter`, `twoPoleCutoff`, default
   15, `twoPoleFreshTurn`) — complementary lower-frequency momentum check,
   also Ehlers.

All are independent toggles. The non-`--optimize` run prints each in
isolation plus a stacked combination.

## Other things worth doing (not yet implemented — pick any to prioritize)

- **Higher-timeframe trend/exhaustion filter** — only fade a breakout when
  it's stretched relative to a longer moving average (e.g. price N·ATR
  above a 50-period EMA), rather than fading fresh continuation moves. ADX
  covers "is the market trending" but not "is *this specific move*
  exhausted," which is a different and complementary question.
- **Momentum divergence** — RSI/MACD divergence between the excursion's
  extreme and price (price makes a new extreme, the oscillator doesn't
  confirm it). Classic exhaustion tell, cited repeatedly in the research
  alongside ADX and wick rejection as one of the standard fakeout filters.
- **Volatility-contraction filter** — only trade when recent ATR (or
  Bollinger/Keltner width) is below its own longer-term average, i.e. the
  market is actually range-bound right now, not just "not currently
  ADX-trending." Different lens on the same regime question ADX asks.
- **Session/time-of-day filter** — once you have real intraday data, some
  hours (e.g. right at a session open) probably produce worse reclaim
  quality than others. Can't usefully test this without real 5m/15m data.
- **Confluence with a higher-timeframe level** — extra weight when the
  band's outer edge also happens to sit near a weekly/monthly high-low or a
  round number; multiple independent reasons for a level to hold is a
  stronger signal than one.

My priority order if you want me to keep going: higher-timeframe exhaustion
filter first (it's the one piece of "why did THIS breakout fail" reasoning
that's still missing), then divergence, then the volatility filter — the
session filter and confluence filter both need real intraday data to be
worth building.

## Data granularity matters

The band logic derives periods generically from each candle's `date`, so it
runs on whatever timeframe you feed it, but what you feed it changes what
the backtest is really testing:

- **Intraday (5m/15m) against a daily band** — the intended real version.
  The band stays fixed all day, a breakout and its eventual reclaim can be
  many bars apart, and `confirmBars` has real resolution (two 15-minute
  closes, not two full days).
- **Daily bars against a daily band (`btc-daily-binance.csv`, bundled
  here)** — each period is exactly one candle, so this degenerates into
  something like a "two-day outside-bar fade." It's useful for validating
  the engine and comparing filters directionally (best found so far: ~58%
  win rate / PF ~2.0 with a 3-day band + ADX filter), not for trusting an
  absolute win rate.

To test the real version: `node fetch-binance-intraday.js SOLUSDT 15m 180
sol-15m-binance.csv` then `node daily-range-breakout.js
sol-15m-binance.csv`. Binance access is blocked from this sandboxed
session's network policy, so run that fetch from an environment with normal
internet access — your own machine or a VPS.

### A note on the 90% accuracy target

Still worth being direct about this: the best combination found so far
(3-day band + ADX filter, on the daily-bar proxy) is ~58% win rate with a
2.0 profit factor — genuinely good, but not 90%. Every filter added this
round narrows trade count in exchange for quality, which is the right trade
to be making, but there's a floor under how selective you can get before
you're just not trading. Real 15m/5m data will move these numbers, possibly
a lot, in either direction — but "55-65% win rate, PF > 1.5-2" remains the
realistic target I'd hold, not 90%.

## Live trading

This is currently backtest-only. `bot.js` still runs the Neural Kernel Bands
strategy live. Wiring this strategy into live execution (BitGet order
placement, position sizing, the safety-check log) would mean adapting the
signal logic in `daily-range-breakout.js` into `bot.js`'s live loop —
ask for that separately once you're happy with backtested performance on
real intraday data.
