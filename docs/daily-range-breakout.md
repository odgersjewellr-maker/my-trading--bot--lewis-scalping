# Daily Range Breakout (failed-breakout reversal)

A prior-day-range strategy: mark the previous day's high/low as a box, and
trade against breakouts that fail to hold.

## Rules

1. **Box** — previous completed day's high and low. The midpoint is just a
   visual reference, not used for entries.
2. **Breakout** — a candle *closes* beyond the box (above the prior day's
   high, or below the prior day's low). Price can stay outside the box for
   any number of candles after that — there's no requirement that the very
   next bar is the one that comes back in. The stop is measured off the
   *furthest* point reached during the whole excursion, not just the first
   breakout candle's wick, since it may have run further before reversing.
3. **Reclaim** — the first candle that *closes* back inside the box,
   whenever that happens, is the signal. That breakout failed, likely a
   stop-hunt/liquidity grab, and price is expected to reverse back into the
   range.
   - Breakout up + reclaim down → **short**
   - Breakout down + reclaim up → **long**
4. **Stop** — just beyond the excursion's extreme (the highest high reached
   during an up-breakout, the lowest low during a down-breakout), plus a
   small ATR buffer so normal noise doesn't stop you out immediately.
5. **Target** — either a fixed reward:risk multiple off that stop distance
   (2:1 by default, matching the reference video), or, with `exitMode:
   "rangeRun"`, the opposite side of the box — i.e. let it run the full
   width of the range instead of taking a fixed multiple.

One trade per box per direction — once a short (or long) has fired off a
given excursion, that side won't fire again until a fresh breakout starts.
An excursion that never reclaims within `maxExcursionBars` is abandoned
rather than tracked forever — this is meant to catch a quick failed
breakout, not a multi-month trend that eventually wanders back through the
level for unrelated reasons (which would also blow the stop distance out to
something absurd).

Position sizing is risk-based: each trade risks a fixed `riskPct` of the
portfolio (1% by default) regardless of how wide that particular stop
distance is, so an unusually large excursion just produces a smaller size,
not a blown-up position.

## Files

| File | What it does |
|------|-------------|
| `daily-range-breakout.js` | Strategy logic + backtest engine. `node daily-range-breakout.js [csv] [--optimize]` |
| `fetch-binance-intraday.js` | Pulls intraday candles from Binance for backtesting. `node fetch-binance-intraday.js SOLUSDT 1h 365` |

## Data granularity matters

The box logic is generic — it derives the "previous day" from each candle's
UTC calendar date, so it works on whatever timeframe you feed it:

- **Intraday (1H, matches the reference chart)** — the box stays fixed for
  every candle within the current day, so a breakout and its reclaim can
  happen a few hours (or bars) apart, same as the picture. This is the real
  version of the strategy and the only one worth trusting a win rate from.
- **Daily bars (`btc-daily-binance.csv`, bundled in this repo)** — each
  candle *is* a full day, so the box shifts every bar. What comes out is an
  "outside-day fade" proxy — useful for sanity-checking the backtest engine
  (position sizing, stop/target mechanics, the filter stack), but it is
  **not** the intraday strategy from the video. On BTC/USD since 2018 the
  base config comes back around 29% win rate / 0.78 profit factor; the best
  the grid optimizer found (3-bar time stop, wider stop buffer, minimum
  breakout size filter) is ~55% win rate / PF 1.8 / Sharpe ~1.0 — a
  reasonable trend/momentum system on daily bars, but nowhere near the ~70%+
  the video reported, and nowhere near a 90% target. That gap is the data,
  not (necessarily) the logic — a failed-breakout reversal is fundamentally
  an intraday liquidity-grab pattern, and a daily-bar "outside day" is a
  much noisier, weaker analog of it.

To reproduce something closer to the video's numbers, fetch real 1H data —
`node fetch-binance-intraday.js SOLUSDT 1h 365 sol-1h-binance.csv` — then
`node daily-range-breakout.js sol-1h-binance.csv`. (Binance access is
blocked from this sandboxed session's network policy, so that fetch has to
be run from an environment with normal internet access — your own machine
or a VPS.)

## Tunable filters (all in `BASE_CFG` / the optimizer grid)

These are the "add more to increase accuracy" levers:

- `rrMult` — reward:risk multiple (default 2), used when `exitMode` is
  `"fixedRR"`.
- `exitMode` — `"fixedRR"` or `"rangeRun"` (target = opposite side of the
  box, i.e. the trade runs the full width of the range).
- `trailBreakevenAtR` — once price has moved this many R in your favor, move
  the stop to breakeven. Mainly useful paired with `rangeRun`, so a runner
  that stalls short of the far side can't turn into a loss.
- `stopBufferATR` — buffer beyond the excursion's extreme, in ATR units.
- `minBreakoutATR` — require the excursion to clear the level by at least
  this many ATR, filtering out breakouts that were basically noise.
- `requireDecisiveClose` / `decisiveFrac` — require the reclaim candle to
  close meaningfully back past the level (toward the box midpoint), not
  just barely reclaim it.
- `useVolumeFilter` / `volumeSMA` / `volumeMult` — require the reclaim
  candle to print above-average volume (more conviction, less drift).
- `useTwoPoleFilter` / `twoPoleCutoff` / `twoPoleFreshTurn` — momentum
  confirmation via Ehlers' 2-pole Super Smoother filter: require the
  smoothed trend to actually be turning in the trade's direction at the
  reclaim bar. `twoPoleFreshTurn: true` is the stricter version — the turn
  has to happen on that exact bar, not just already be underway.
- `maxHoldBars` — time stop; exits at market if neither stop nor target hit
  within N bars.
- `maxExcursionBars` — abandon an unresolved excursion after this many bars
  (default 20) instead of tracking it indefinitely.
- `riskPct` — fraction of portfolio risked per trade (default 0.01 = 1%).

Run `node daily-range-breakout.js [csv] --optimize` to grid-search rrMult,
stopBufferATR, minBreakoutATR, maxHoldBars, the two-pole filter, and
exitMode together, ranked by Sharpe.

### Other things worth trying once you have real intraday data

- A session/hour-of-day filter — some failed breakouts only resolve
  reliably during certain hours (e.g. avoid signals born right at a session
  open, when the "breakout" might just be genuine follow-through).
- A higher-timeframe trend filter — skip fading breakouts that align with a
  strong 4H/daily trend, since a failed-breakout-reversal is a counter-trend
  bet by nature and works best in range-bound conditions.
- Requiring the breakout excursion itself to show a rejection wick (a long
  wick beyond the extreme rather than a grinding series of closes further
  out), which is closer to what "liquidity grab" actually looks like on a
  chart.

### A note on the 90% accuracy target

Worth being direct about this: on everything backtested so far (the daily-
bar proxy), stacking every filter available narrows the trade count a lot
but tops out around 55-60% win rate, not 90%. A 90% win rate is achievable
in isolation, but almost always by taking a very small, very-close target
(so most trades "win" a tiny amount) while a rare large loss erodes it — the
win rate looks great and the strategy still loses money. What actually
matters is profit factor and Sharpe, not win rate alone. The filters above
are the right levers to pull to raise win rate meaningfully (decisive close,
volume, momentum confirmation, higher-timeframe alignment all trade
frequency for quality), but I'd treat "~55-65% win rate with PF > 1.5" as a
realistic, still very good outcome to aim for once tested on real intraday
data, rather than holding out for 90%.

## Live trading

This is currently backtest-only. `bot.js` still runs the Neural Kernel Bands
strategy live. Wiring this strategy into live execution (BitGet order
placement, position sizing, the safety-check log) would mean adapting the
signal logic in `daily-range-breakout.js` into `bot.js`'s live loop —
ask for that separately once you're happy with backtested performance on
real intraday data.
