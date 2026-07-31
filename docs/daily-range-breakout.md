# Range Band Bounce

Trade the range **between** two liquidity bands — not a breakout of them.
The bands mark where resting liquidity sits just outside the normal daily
range; the trade is the bounce back into the range once that liquidity gets
swept, not a bet that the range breaks.

## Rules

1. **Band** — take the last `bandLookback` completed days (default 2):
   - upper band = `[min(H1,H2), max(H1,H2)]`
   - lower band = `[min(L1,L2), max(L1,L2)]`
   - **range** (the zone both days agree was "inside," and the thing we
     actually trade) = `[max(L1,L2), min(H1,H2)]`
   `bandLookback: 1` collapses each band to a single previous-day line.
   `periodMode` still controls what a "period" means (`"day"` default, or
   `"week"`).
2. **Visit** — price closes past the **near edge** of a band (leaves the
   range into liquidity territory). Also supported: a single candle that
   *wicks* into (or through) the band and closes back inside the range in
   the same bar — the sharp, one-candle version of a liquidity grab, and the
   cleanest example of the whole idea. Checked first, before the slower
   multi-bar case.
3. **Bail, don't fade, on a real breakout** — if a later candle *closes*
   past the **far edge** of the band (both prior days' extremes), that's
   sustained conviction beyond the range, not a liquidity grab. Stand aside
   (`invalidateOnRealBreakout`, on by default) instead of fading it. This is
   the one-sentence summary of the whole redesign: we're not trying to
   break out of the range, so a candle that actually confirms a breakout
   takes us out of the setup rather than into a trade.
4. **Reclaim** — the first candle that closes back past the near edge, into
   the range, is the reclaim candle (unless step 3 already fired).
5. **Direction confirmation (`confirmBars`, default 2)** — starting from the
   reclaim candle, each subsequent candle has to close further in the
   trade's direction than the one before it. A candle that closes the other
   way scraps the setup. `confirmBars: 1` = enter right on the reclaim.
6. **Stop** — beyond the furthest point reached while outside the range,
   plus an ATR buffer. **Target** — a fixed reward:risk multiple (2:1
   default), or `exitMode: "rangeRun"`, which rides from one side of the
   range to the near edge of the *opposite* band.
7. **Session filter (`useSessionFilter`, default on)** — only *enter* during
   the London and New York session-open windows, for good early volatility.
   Visit-tracking and direction confirmation still run at all hours (so
   structure that built up overnight is ready to trade the moment a session
   opens) — only the actual entry is gated. `sessions: [8, 13]` (UTC hours —
   ~8am London time, ~8am New York time) and `sessionWindowHours: 3` are the
   defaults; adjust both to trade 2-4 hours from either open, as you
   described. These are fixed UTC hours, not DST-aware — London's actual
   local open shifts by an hour across BST/GMT, same for New York's
   EST/EDT. Nudge `sessions` by ±1 depending on time of year if you want
   tighter precision; the defaults split the difference.

**No "one trade per box" limit.** The whole premise is that price bounces
between the two bands repeatedly while the range holds — every fresh visit
to a band is its own independent setup, which is what "we know it's gonna
bounce between liquidity" means mechanically. Position sizing is risk-based
(`riskPct`, default 1% of portfolio per trade).

## Files

| File | What it does |
|------|-------------|
| `daily-range-breakout.js` | Strategy logic + backtest engine. `node daily-range-breakout.js [csv] [--optimize]` |
| `fetch-binance-intraday.js` | Pulls intraday candles from Binance. Defaults to SOLUSDT 15m/180d — `node fetch-binance-intraday.js SOLUSDT 15m 180` or `... SOLUSDT 5m 90` |

## Confirmation filters, in priority order

1. **ADX regime filter** (`useADXFilter`, `adxMaxThreshold`, default 30) —
   still first choice. Range-bound conditions are exactly what this
   strategy wants; ADX above the threshold blocks new entries.
2. **Rejection wick filter** (`useRejectionWickFilter`, `rejectionWickFrac`,
   default 0.3) — requires the candle that set the visit's extreme to show a
   real wick beyond its body, not a strong-bodied continuation candle.
3. **Fisher Transform** (`useFisherFilter`, `fisherPeriod`, default 9,
   `fisherFreshCross`) — Ehlers' turning-point oscillator.
4. **2-pole Super Smoother** (`useTwoPoleFilter`, `twoPoleCutoff`, default
   15, `twoPoleFreshTurn`) — complementary momentum check, also Ehlers.

All independent toggles; the non-`--optimize` run prints each in isolation
plus a stacked combination, and also shows what happens if you turn OFF
`invalidateOnRealBreakout` (worse, on the data tested — fading genuine
breakouts loses).

## Other things worth doing (not yet implemented — pick any to prioritize)

- **Higher-timeframe exhaustion filter** — only take a bounce when the visit
  is stretched relative to a longer moving average, rather than any visit.
- **Momentum divergence** — RSI/MACD divergence between the visit's extreme
  and price.
- **Volatility-contraction filter** — trade only when recent ATR/Bollinger
  width is below its own average, i.e. the market is actually range-bound
  right now (a different lens on the same question ADX asks).
- **Confluence with a higher-timeframe level** — extra weight when a band's
  far edge also sits near a weekly/monthly level or a round number.

## Data granularity matters

The band logic derives periods generically from each candle's `date`, so it
runs on whatever timeframe you feed it, but what you feed it changes what
the backtest is really testing:

- **Intraday (5m/15m) against a daily band** — the intended real version.
  The band stays fixed all day, a visit and its bounce can be many bars
  apart, and `confirmBars` has real resolution.
- **Daily bars against a daily band (`btc-daily-binance.csv`, bundled
  here)** — each period is exactly one candle, a coarse proxy. Useful for
  validating the engine and comparing filters directionally. Best found so
  far on this proxy: the grid optimizer's top Sharpe config lands around
  59% return / Sharpe 1.10 / PF 1.83 on 80 trades (2-day band, 3:1 R:R, all
  filters stacked); a separate high-frequency config (single-line band +
  wick filter, no direction confirmation) hits **80% win rate over 303
  trades** with PF 1.30 — worth noting since it's the closest thing to your
  accuracy target seen yet, though a lower PF per trade than the
  higher-R:R configs. None of this is a substitute for real 15m/5m data.

To test the real version: `node fetch-binance-intraday.js SOLUSDT 15m 180
sol-15m-binance.csv` then `node daily-range-breakout.js
sol-15m-binance.csv`. Binance access is blocked from this sandboxed
session's network policy, so run that fetch from an environment with normal
internet access — your own machine or a VPS.

The session filter specifically needs real intraday timestamps to do
anything — it's a correctly-wired no-op on the daily-bar proxy (verified:
identical results with it on vs. off) since a plain "YYYY-MM-DD" date has no
hour to filter on. It'll only actually narrow trade selection once you're
running this against 15m/5m data.

### A note on the 90% accuracy target

The 80%-win-rate / 303-trade result above is the closest this has come to
your target, and it's worth understanding why: confirmBars=1 (no
confirmation delay) with a single-line band and a wick filter takes far
more, far smaller-edge trades — profit factor is only 1.30, versus 1.6-1.9
for the more selective configs at a third the trade count. High win rate
and high quality-per-trade are usually in tension, not both maximizable at
once. I'd rather hand you both numbers and let you pick the tradeoff than
just chase the win-rate figure — a 90% win rate quoted without its profit
factor and trade count isn't information.

## Live trading

This is currently backtest-only. `bot.js` still runs the Neural Kernel Bands
strategy live. Wiring this strategy into live execution (BitGet order
placement, position sizing, the safety-check log) would mean adapting the
signal logic in `daily-range-breakout.js` into `bot.js`'s live loop —
ask for that separately once you're happy with backtested performance on
real intraday data.
