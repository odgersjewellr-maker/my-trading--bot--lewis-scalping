# Daily Range Breakout (failed-breakout reversal)

A prior-day-range strategy: mark the previous day's high/low as a box, and
trade against breakouts that fail to hold.

## Rules

1. **Box** — previous completed day's high and low. The midpoint is just a
   visual reference, not used for entries.
2. **Breakout candle** — any candle that *closes* beyond the box (above the
   prior day's high, or below the prior day's low).
3. **Confirmation candle** — the very next candle closes back *inside* the
   box. That's the signal: the breakout failed, likely a stop-hunt/liquidity
   grab, and price is expected to reverse back into the range.
   - Breakout up + reclaim down → **short**
   - Breakout down + reclaim up → **long**
4. **Stop** — just beyond the breakout candle's wick (its high for shorts,
   its low for longs), plus a small ATR buffer so normal noise doesn't stop
   you out immediately.
5. **Target** — a fixed reward:risk multiple off that stop distance. 2:1 by
   default, matching what was used in the reference video.

One trade per box per direction — once a short (or long) has fired off a
given day's box, that side won't fire again until the box rolls over.

## Files

| File | What it does |
|------|-------------|
| `daily-range-breakout.js` | Strategy logic + backtest engine. `node daily-range-breakout.js [csv] [--optimize]` |
| `fetch-binance-intraday.js` | Pulls intraday candles from Binance for backtesting. `node fetch-binance-intraday.js SOLUSDT 1h 365` |

## Data granularity matters

The box logic is generic — it derives the "previous day" from each candle's
UTC calendar date, so it works on whatever timeframe you feed it:

- **Intraday (1H, matches the reference chart)** — the box stays fixed for
  every candle within the current day, so a breakout and its confirmation
  candle can happen a few hours apart, same as the picture. This is the real
  version of the strategy and the only one worth trusting a win rate from.
- **Daily bars (`btc-daily-binance.csv`, bundled in this repo)** — each
  candle *is* a full day, so the box shifts every bar. What comes out is an
  "outside-day fade" — yesterday closed outside the day-before's range,
  today closed back inside it. It's a legitimate related pattern, useful for
  sanity-checking the backtest engine, but it is **not** the intraday
  strategy from the video and its numbers (~36% win rate, PF ~1.1 on BTC/USD
  since 2018) shouldn't be compared to the ~70%+ the video reported.

To reproduce something closer to the video's numbers, fetch real 1H data —
`node fetch-binance-intraday.js SOLUSDT 1h 365 sol-1h-binance.csv` — then
`node daily-range-breakout.js sol-1h-binance.csv`. (Binance access is
blocked from this sandboxed session's network policy, so that fetch has to
be run from an environment with normal internet access — your own machine
or a VPS.)

## Tunable filters (all in `BASE_CFG` / the optimizer grid)

These are the "add more to increase accuracy" levers:

- `rrMult` — reward:risk multiple (default 2).
- `stopBufferATR` — buffer beyond the breakout candle's wick, in ATR units.
- `minBreakoutATR` — require the breakout to clear the level by at least
  this many ATR, filtering out breakouts that were basically noise.
- `requireDecisiveClose` / `decisiveFrac` — require the confirmation candle
  to close meaningfully back past the level (toward the box midpoint), not
  just barely reclaim it.
- `useVolumeFilter` / `volumeSMA` / `volumeMult` — require the confirmation
  candle to print above-average volume (more conviction, less drift).
- `maxHoldBars` — time stop; exits at market if neither stop nor target hit
  within N bars.

Run `node daily-range-breakout.js [csv] --optimize` to grid-search these and
rank by Sharpe. Other things worth trying once you have real intraday data:
a session/hour-of-day filter (some breakouts only fail reliably during
certain hours), a higher-timeframe trend filter (skip fading breakouts that
align with a strong 4H trend), and requiring the breakout candle itself to
show a rejection wick rather than a clean close.

## Live trading

This is currently backtest-only. `bot.js` still runs the Neural Kernel Bands
strategy live. Wiring this strategy into live execution (BitGet order
placement, position sizing, the safety-check log) would mean adapting the
signal logic in `daily-range-breakout.js` into `bot.js`'s live loop —
ask for that separately once you're happy with backtested performance on
real intraday data.
