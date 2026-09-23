# LuxAlgo "Ultimate AMD FVG Strategy": notes from a video screenshot

Source: one screenshot of a LuxAlgo Instagram reel ("Wall Street trades on data
and automat…"). The notes come from that single frame, not the full video. The
strategy's source code is closed (LuxAlgo Quant), so it isn't included here.
These are only the visible settings plus an outline of the concept.

## Context shown in the frame

| Field | Value |
|---|---|
| Instrument | NASDAQ 100 E-mini Futures (NQ1!) |
| Chart TF | Low timeframe, intraday (x-axis ticks 15 min apart) |
| Backtest window | Last 90 days (Deep Backtesting) |
| Total PnL | +25,575.00 USD (+2.56%) |
| Profit factor | 2.221 |
| Equity curve | Dips early (~May), then climbs steadily |

A +2.56% return on +$25.6k PnL implies roughly $1M of initial capital in the
Properties tab. That makes the % return small; the profit factor is the
more useful number.

## Inputs: AMD Settings

| Input | Value |
|---|---|
| Accumulation Length | 40 |
| Accumulation Max Range (%) | 0.15 |
| Breakout Type | Bodies |
| Max Manipulation Length (Bars) | 20 |
| Max Bars After Manipulation | 30 |
| Max AMD Cycles Shown | 5 |
| Enable Longs | ✅ |
| Enable Shorts | ✅ |

## Inputs: FVG / IFVG Settings

| Input | Value |
|---|---|
| Entry Trigger | IFVG |
| FVG ATR Length | 14 |
| FVG Min ATR Multiplier | 1.25 |
| FVG Projection Bars | 5 |
| Max Active FVGs / IFVGs | 15 |
| Filter Overlapping Gaps | ✅ |
| Show FVGs | ☐ |
| Show IFVGs | ✅ |

The Properties tab (sizing, commission, slippage), the rest of the Inputs list
below the fold, and any exit/SL/TP settings aren't visible in the frame.

## Probable logic (inferred from input names, not confirmed)

1. **Accumulation.** Over the last 40 bars, price stays within a range of
   ≤ 0.15% (high-low relative to price).
2. **Manipulation.** A candle *body* closes outside that range (a fake-out),
   and the move must happen within 20 bars.
3. **Distribution / entry.** Within 30 bars of the manipulation, wait for an
   **inverse FVG**: a fair value gap whose size is ≥ 1.25 × ATR(14) and which
   price then closes through, flipping its polarity. Enter in the direction
   opposite the manipulation (a sweep of the range low followed by a bullish
   IFVG means long, and the mirror case means short).
4. Only 15 FVGs/IFVGs are tracked at once, and overlapping gaps are merged or
   filtered out.

## Relevance to this bot

This is a separate strategy from the Neural Kernel Bands logic in `bot.js`. It
was tested on NQ futures, not BTC/SOL. Porting it would need its own
backtest script (in the style of `backtest-confluence.mjs`) on BTC/SOL data,
followed by paper trading, before it goes anywhere near `bot.js` or `rules.json`.
Note that 0.15% is a tight range for crypto volatility, so that parameter
would probably need retuning.
