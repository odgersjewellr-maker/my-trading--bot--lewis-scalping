# Daily Sweep Strategy (PDH/PDL + session liquidity)

Research strategy, inspired by the "daily → H1, PDH" chart idea. Backtest: `backtest-sweep.mjs`.
**Not wired into `bot.js`.** It doesn't trade live until it's validated and deliberately added.

## The idea in one picture

```
 Daily:  bullish candle closes ── PDH ─────────────── target (draw on liquidity)
 H1 next day:                       \    /\  /‾‾‾‾‾ break of PDH
                                     \  /  \/
 Asia low ───────────────────────────\/───────── swept in London/NY
                                     ↑ wick below = stops taken, H1 closes back above → BUY
```

Price is drawn to liquidity: the stop orders resting above the previous day's high (PDH),
below the previous day's low (PDL), and beyond the Asia session range. A **sweep** happens
when price pokes through one of those levels, triggers the stops, and then closes back inside.
That move is often the reversal into the real move of the day.

## Timeframes and sessions (UTC)

| Session | Hours (UTC) | Role |
|---|---|---|
| Asia | 00:00–07:00 | Builds the range. Its high and low are liquidity. **No trades.** |
| London | 07:00–12:00 | First sweep window |
| New York | 12:00–20:00 | Second sweep window. Last entry before 20:00 |
| Flat | 20:00 | Close anything still open. No overnight holds |

Change these hours to match your broker and daylight saving time. London/NY open shifts by
1h in summer.

## Rules

**1. Daily bias (D)**
- If yesterday's daily candle closed **bullish** (close > open), look for longs only.
- If it closed bearish, look for shorts only.
- (`bias: "none"` trades both ways. The backtest compares the two.)

**2. Mark the levels (before London opens)**
- PDH / PDL: the previous day's high and low
- Asia high / Asia low: the 00:00–07:00 UTC range

**3. Wait for the sweep (H1, London or NY session)**
- Long: an H1 candle wicks **below** the Asia low or the PDL.
- Short: an H1 candle wicks **above** the Asia high or the PDH.

**4. Entry: the reclaim**
- Within 3 H1 candles of the sweep, an H1 candle **closes back inside** the level
  (above the low for longs, below the high for shorts). Enter at that close.
- If no reclaim comes in time, the setup is invalid.

**5. Stop**
- Beyond the sweep's extreme wick, plus a 0.05% buffer.
- Skip the trade if the stop is closer than 0.15% (fees eat it) or wider than 2%.

**6. Target**
- Default: the **opposite side liquidity**, which is PDH (or the Asia high if higher) for longs
  and PDL / Asia low for shorts. This is the "break of PDH" leg in the chart.
- If that level is less than 2R away, use a fixed 2R target instead.

**7. Risk management**
- Maximum 1 trade per day.
- Fixed fractional risk per trade (e.g. 0.5–1% of the account). Size = risk $ ÷ stop distance.
- Close everything by 20:00 UTC.
- Keep the existing guardrails (`MAX_TRADES_PER_DAY`, `PROP_DAILY_GUARD`, `PROP_DD_GUARD`) on
  top of these rules if this is ever wired into the bot.

## Running the backtest

Run this on your own machine or in GitHub Actions. The Claude cloud container can't reach
exchange APIs.

```bash
node backtest-sweep.mjs --fetch BTCUSDT           # -> btcusdt-1h.csv (2022 → now)
node backtest-sweep.mjs btcusdt-1h.csv --verbose  # trade-by-trade log + summary
node backtest-sweep.mjs btcusdt-1h.csv --optimize # compare levels / bias / target / RR
node backtest-sweep.mjs --fetch SOLUSDT && node backtest-sweep.mjs solusdt-1h.csv
```

The results are in R (multiples of risk), after 0.06% round-trip fees and slippage. The
summary also splits results by which level was swept (Asia low/high, PDL/PDH), so you can see
which sweeps carry the edge.

### How to judge it
- Look for **PF > 1.3, at least 100 trades, and a max drawdown your prop rules can survive**
  (e.g. at 0.5% risk, a 10R drawdown = 5%).
- Optimize on 2022–2024, then check that the winning config still holds on 2025+ data.
  A config that only wins in-sample is overfit.
- Bar-level limitation: if the stop and target both fall inside the same H1 candle, the
  backtest assumes the stop hit first (pessimistic).

## Caveats
- The payout screenshots in the video are marketing. They don't show win rate, drawdown,
  or how many accounts were blown along the way. Only your own backtest numbers count.
- This was built from the chart in the screenshot plus the session/daily sweep idea you
  described. The video's audio wasn't available, so details the presenter says out loud
  (e.g. a specific entry candle pattern or session) aren't included.
