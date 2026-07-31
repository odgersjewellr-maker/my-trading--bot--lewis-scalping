# Weekly Range Breakout (failed-breakout reversal)

A prior-range strategy: mark the previous period's high/low as a box, and
trade against breakouts that fail to hold. Default is a **weekly** box
traded on intraday candles (5m/15m) with a 2-bar direction confirmation
before entry; the original per-day version is still available via
`periodMode: "day"`.

## Rules

1. **Box** — previous completed period's high and low (`periodMode: "week"`
   → previous ISO week, Monday-Sunday; `"day"` → previous UTC calendar day).
   The midpoint is a visual reference only, used by the optional decisive-
   close filter.
2. **Breakout** — a candle *closes* beyond the box. Price can stay outside
   for any number of candles after that — there's no requirement that the
   very next bar is the one that comes back in. The stop is measured off the
   *furthest* point reached during the whole excursion, not just the first
   breakout candle's wick, since it may have run further before reversing.
   An excursion that never reclaims within `maxExcursionBars` is abandoned
   rather than tracked forever.
3. **Reclaim** — the first candle that *closes* back inside the box is the
   reclaim candle. That's not the entry yet.
4. **Direction confirmation (`confirmBars`, default 2)** — starting from the
   reclaim candle, each subsequent candle has to close further in the
   trade's direction than the one before it. Entry fires on the candle where
   the count reaches `confirmBars`. If a candle instead closes back the
   *other* way, the setup is scrapped — no re-arming mid-excursion, it has
   to wait for a fresh breakout. `confirmBars: 1` reproduces the original
   "enter right on the reclaim candle" behavior, for comparison.
5. **Stop** — beyond the excursion's extreme (its worst point while
   outside the box), plus a small ATR buffer.
6. **Target** — either a fixed reward:risk multiple off that stop distance
   (2:1 by default), or `exitMode: "rangeRun"`, which targets the opposite
   side of the box instead, optionally with a breakeven stop trail once
   price has moved `trailBreakevenAtR` in your favor.

One trade per box per direction. Position sizing is risk-based — every
trade risks a fixed `riskPct` of the portfolio (1% by default) off the
actual stop distance, so a wide excursion just produces a smaller size
rather than a blown-up position.

## Files

| File | What it does |
|------|-------------|
| `daily-range-breakout.js` | Strategy logic + backtest engine. `node daily-range-breakout.js [csv] [--optimize]` |
| `fetch-binance-intraday.js` | Pulls intraday candles from Binance. Defaults to SOLUSDT 15m/180d — `node fetch-binance-intraday.js SOLUSDT 15m 180` or `... SOLUSDT 5m 90` |

## Direction-confirmation indicators

You asked for research into what would genuinely complement this pattern —
here's what's implemented and why, in priority order:

1. **ADX regime filter** (`useADXFilter`, `adxMaxThreshold`, default 30) —
   the single most commonly cited fix for fakeout/fade strategies in the
   trading literature. This strategy fades failed breakouts, which is an
   inherently counter-trend bet — it works when the market is range-bound
   and gets run over when the market is genuinely trending. ADX above the
   threshold blocks new entries. This is the filter I'd try first.
2. **Fisher Transform** (`useFisherFilter`, `fisherPeriod`, default 9,
   `fisherFreshCross`) — Ehlers' Fisher Transform maps price into a
   near-Gaussian distribution specifically so turning points produce sharp,
   unambiguous peaks instead of the mushy extremes a raw oscillator like
   RSI gives you. Direction = the Fisher line vs. its own 1-bar-lagged
   trigger line, the same way you'd read a MACD/signal cross. Purpose-built
   for exactly what you asked for — a "has direction actually turned"
   confirmation.
3. **2-pole Super Smoother oscillator** (`useTwoPoleFilter`, `twoPoleCutoff`,
   default 15, `twoPoleFreshTurn`) — from the earlier round, kept as a
   complementary, lower-frequency-focused momentum check. Also Ehlers;
   pairs thematically with the Fisher Transform (both come from the same
   "Cycle Analytics for Traders" toolkit).

All three are boolean toggles you can combine freely — the non-`--optimize`
run prints each in isolation plus a stacked combination so you can see what
each one actually buys you before committing to a stack.

## Data granularity matters

The box logic derives periods generically from each candle's `date`, so it
works on whatever timeframe you feed it — but the granularity of what you
feed it changes what the backtest is really testing:

- **Intraday (5m/15m) against a weekly box** — the intended real version.
  The box stays fixed all week, a breakout and its eventual reclaim can be
  many bars apart intraday, and `confirmBars` has enough resolution to mean
  something (two 15-minute closes, not two full days).
- **Daily bars against a weekly box (`btc-daily-binance.csv`, bundled
  here)** — each week only has ~5-7 daily candles, so this exercises the
  multi-bar-excursion and confirmation machinery correctly (unlike a
  single-candle-per-period case), but at far coarser resolution than the
  real thing. Useful for validating the engine and comparing filters
  directionally, not for trusting an absolute win rate.
- **Daily bars against a daily box (`periodMode: "day"`)** — the original
  fallback: each period is exactly one candle, so it degenerates into an
  "outside-day fade," a related but different pattern.

To test the real version, fetch actual 15m or 5m data — `node
fetch-binance-intraday.js SOLUSDT 15m 180 sol-15m-binance.csv` — then `node
daily-range-breakout.js sol-15m-binance.csv`. Binance access is blocked from
this sandboxed session's network policy, so that fetch has to run from an
environment with normal internet access — your own machine or a VPS.

## Tunable parameters (all in `BASE_CFG` / the optimizer grid)

- `periodMode` — `"week"` (default) or `"day"`.
- `confirmBars` — bars of direction confirmation after the reclaim before
  entry (default 2; `1` = enter immediately on the reclaim).
- `rrMult` / `exitMode` / `trailBreakevenAtR` — target shape.
- `stopBufferATR` — buffer beyond the excursion's extreme, in ATR units.
- `minBreakoutATR` — require the excursion to clear the level by at least
  this many ATR (filters out marginal breakouts).
- `requireDecisiveClose` / `decisiveFrac` — require the reclaim to push
  meaningfully back past the level, not just barely poke back in.
- `useVolumeFilter` / `volumeSMA` / `volumeMult` — require above-average
  volume on the reclaim.
- `useTwoPoleFilter` / `useFisherFilter` / `useADXFilter` — the three
  direction/regime confirmation indicators above.
- `maxHoldBars` — time stop.
- `maxExcursionBars` — abandon an unresolved excursion after this many bars
  (default 20) instead of tracking it indefinitely.
- `riskPct` — fraction of portfolio risked per trade (default 0.01 = 1%).

Run `node daily-range-breakout.js [csv] --optimize` to grid-search rrMult,
stopBufferATR, minBreakoutATR, confirmBars, the filter stack, and exitMode
together, ranked by Sharpe.

### A note on the 90% accuracy target

Worth staying direct about this, even with the new filters in place: on
everything backtested so far (still the daily-bar proxy — real intraday
data hasn't been tested yet), the best filter combinations land around
40-55% win rate with profit factor 1.5-2.5, not 90%. A 90% win rate is
achievable in isolation, almost always by taking a very small, very-close
target so most trades "win" a tiny amount while a rare large loss erodes
it — the win rate looks great and the strategy still loses money. Profit
factor and Sharpe are what actually matter, not win rate in isolation. The
ADX/Fisher/2-pole filters above are the right levers for raising win rate
meaningfully (each trades frequency for quality), and real 15m/5m data will
likely move these numbers a fair amount in either direction versus the
daily-bar proxy — but I'd treat "50-65% win rate with PF > 1.5" as the
realistic, still very good target, rather than holding out for 90%.

## Live trading

This is currently backtest-only. `bot.js` still runs the Neural Kernel Bands
strategy live. Wiring this strategy into live execution (BitGet order
placement, position sizing, the safety-check log) would mean adapting the
signal logic in `daily-range-breakout.js` into `bot.js`'s live loop —
ask for that separately once you're happy with backtested performance on
real intraday data.
