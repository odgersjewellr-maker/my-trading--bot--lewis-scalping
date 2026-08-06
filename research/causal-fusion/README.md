# Causal-Fusion — experimental research strategy

**Status: research only. Not wired into `bot.js`, `rules.json`, or live execution. Nothing here places an order.**

This is a separate track from the live NKB / VWAP-RSI-EMA bot, built to explore a genuinely different mechanism rather than another indicator tweak. It combines two ideas from 2025/2026 market-microstructure research instead of fixed TA thresholds:

1. **Dynamic lead-lag fusion** — which data stream currently leads price changes (order flow, funding, open interest) is re-estimated every bar on a trailing window, instead of being hardcoded. When a stream's predictive relationship decays or flips sign, its weight in the signal decays or flips with it.
2. **Cascade early-warning ensemble** — liquidation cascades are treated as critical-phenomena events (per recent research modeling them as phase transitions), where no single precursor signal is reliable across events. So five independent early-warning metrics vote, rather than one hardcoded threshold rule.

The two layers combine into a conviction score: when the cascade-risk layer and the lead-lag direction **agree**, conviction is boosted; when they **disagree**, conviction is **dampened**, not overridden — that disagreement is treated as a signal of being near a regime boundary, where research shows these features are least reliable.

## What data this actually uses (v1)

Everything here is free, keyless Binance USDT-M futures data with real history:

| Stream | Source | Used for |
|---|---|---|
| Price / volume | `fapi.binance.com/fapi/v1/klines` | returns |
| Taker-buy ratio (order-flow proxy) | same klines response | CVD-style delta — real order-book depth history isn't free, this is the closest available proxy |
| Funding rate | `fapi.binance.com/fapi/v1/fundingRate` | positioning skew (long history available) |
| Open interest | `fapi.binance.com/futures/data/openInterestHist` | leverage build-up (Binance only serves ~20-30 days of this for free — see limitation below) |

**Not included, on purpose, rather than faked:** real order-book depth history, on-chain exchange flow, macro/DXY, social attention. None have a free, keyless, historical API. The architecture (`lib/features.js`) is built so any of these can be added as another stream later without restructuring the lead-lag or cascade modules — they just need a real data source first.

## Known limitations

- **OI history window is short (~20-30 days)** — a Binance platform limit, not something this code can page around. The cascade ensemble degrades gracefully (drops the OI vote) outside that window rather than pretending it has data it doesn't.
- **"Dynamic lead-lag fusion" here is a transparent statistical approximation** (rolling windowed correlation), not the DeltaLag neural model from the research it's inspired by. That's a deliberate choice for a first version — it's auditable, and every weight can be explained. Upgrading to a learned model is a natural v2 if this shows promise.
- **The backtest holds each signal for exactly one bar** (the signal only claims to forecast next-bar direction). It does not model stops, multi-bar trends, or slippage beyond a flat ~5bps turnover cost. Real execution would do worse than the backtest, not better — that's the normal direction of backtest-to-live slippage.
- **One backtest window is not proof of an edge.** Re-run across symbols, timeframes, and periods, and check how sensitive the result is to the window/threshold constants before trusting it with size.

## Files

| File | Purpose |
|---|---|
| `lib/binanceData.js` | Fetches + disk-caches klines, funding, OI (free Binance futures endpoints) |
| `lib/features.js` | Aligns raw streams onto one bar timeline with no-lookahead forward-fill |
| `lib/leadlag.js` | Rolling lead-lag correlation → adaptive direction score |
| `lib/cascade.js` | 5-metric early-warning ensemble → cascade risk + vulnerable side |
| `lib/signal.js` | Combines both into a conviction-weighted signal, agreement boosts / disagreement dampens |
| `backtest.js` | Walk-forward backtest CLI, writes an equity-curve CSV to `out/` |
| `live-preview.js` | Prints the current signal for one or more symbols — read-only, no orders |

## Running it

```bash
npm install
node research/causal-fusion/backtest.js BTCUSDT 1h 45
node research/causal-fusion/backtest.js SOLUSDT 1h 45
node research/causal-fusion/live-preview.js
```

Or via the npm scripts added to the root `package.json`:

```bash
npm run research:backtest -- BTCUSDT 1h 45
npm run research:preview -- SOLUSDT
```

**Note on this sandbox:** `fapi.binance.com` is blocked by this environment's outbound proxy policy, so the live-data path could only be validated with an offline synthetic-data smoke test here (pipeline runs end-to-end, all outputs stay in their expected bounds, no NaNs). The actual Binance response handling follows Binance's documented API shapes but hasn't been exercised against real data yet — that first real run needs to happen on your machine, where Binance isn't blocked.

## Suggested next steps once it runs on your machine

1. Run the backtest across both BTCUSDT and SOLUSDT, multiple `DAYS` windows, and eyeball whether the Sharpe/drawdown numbers hold up or are an artifact of one lucky window.
2. Check `out/equity-*.csv` against buy-and-hold — a real edge should show up as a smoother equity curve, not just a higher endpoint.
3. Sweep the constants (`WINDOW` in `leadlag.js`, `BASELINE_WINDOW`/`VOTE_THRESHOLD` in `cascade.js`) to see how sensitive results are — if small changes flip the conclusion, it's noise, not edge.
4. Only after that: consider paper-trading it standalone (still separate from `bot.js`) before ever touching the live rules.
