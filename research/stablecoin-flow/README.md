# Stablecoin Mint-Flow — experimental research strategy

**Status: research only. Not wired into `bot.js`, `rules.json`, or live execution. Nothing here places an order.**

Second research track, deliberately different in kind from `research/causal-fusion/`: that one is an hourly, intraday microstructure signal (order flow, funding, OI, liquidation-cascade risk). This one is a slow, multi-day macro-liquidity signal — new USDT/USDC issuance as a leading indicator for direction. If causal-fusion's edge decays, this shouldn't decay with it; it's a different risk factor, not a variant of the same one.

## The mechanism

Tether and Circle mint new stablecoin supply before it shows up as buying pressure on exchanges. There's real documented precedent for this lag: a Dec 2024 Tether mint preceded a 10-day, 8% BTC rally; a Sept 2025 ~$2B mint preceded a 30-day run to BTC's all-time high (sources in the original research conversation). The idea here is to systematize that instead of eyeballing it after the fact.

Both USDT and USDC emit a standard ERC-20 `Transfer` event when supply is created or destroyed — `Transfer(0x0 -> treasury)` for a mint, `Transfer(treasury -> 0x0)` for a burn. That's the same heuristic Whale-Alert-style trackers use, and it's queryable for free via Etherscan.

Same dynamic lead-lag method as causal-fusion (`lib/flowSignal.js`): instead of hardcoding "big mint = bullish," a trailing correlation between flow features (raw daily net flow, and 3/7/14-day cumulative sums) and next-day returns is re-estimated continuously, so the model can pick up on the relationship strengthening, weakening, or flipping over time rather than assuming it's fixed.

## What data this actually uses (v1)

| Stream | Source | Notes |
|---|---|---|
| USDT/USDC mint & burn events | `api.etherscan.io` — `Transfer` events involving the null address, filtered per token contract | Free, but needs an API key (see setup below) |
| BTC/SOL daily close | `api.binance.com` spot klines | Free, no key |

## Known limitations — read before trusting any backtest number

- **Ethereum-only.** The majority of USDT supply actually lives on Tron, which isn't covered here — there's no free equivalent wired up yet. This is a partial view of stablecoin issuance, not the whole picture. A real v2 would add Tron coverage (TronGrid has a free tier).
- **Event sparsity is a real statistical risk, not just a caveat.** Large mints happen maybe a few dozen times a year. A 180-day correlation window can easily contain only a handful of genuine "events" among mostly-zero days. That makes any correlation this finds more fragile and more prone to being a coincidence than causal-fusion's hourly signals, which have thousands of observations per window. `flowSignal.js` uses a higher minimum lead-strength threshold (0.08 vs causal-fusion's 0.05) specifically because of this, but that's a partial mitigation, not a fix. Don't trust a good backtest number here without checking how many actual events it's built on.
- **One-day-forward, not the multi-day horizon implied by the precedent examples.** The backtest sizes and marks-to-market daily (same convention as causal-fusion) rather than holding a fixed 10 or 30-day position — the slow-moving cumulative features let conviction persist naturally across days when it's elevated, but this isn't literally re-testing "does a mint predict a 10-day rally," it's testing "does elevated flow predict tomorrow's direction, repeatedly." Worth being aware these aren't quite the same question.
- **~2 years of default backtest history (`DAYS=720`)** — mint events need real history to say anything meaningful; don't shrink this without a reason.

## Setup

Needs a free Etherscan API key (signup only, no cost):

1. Create an account at https://etherscan.io/apis
2. Add to your `.env`: `ETHERSCAN_API_KEY=your_key_here`

## Files

| File | Purpose |
|---|---|
| `lib/etherscanData.js` | Fetches + disk-caches USDT/USDC mint/burn events (Ethereum only) |
| `lib/priceData.js` | Daily BTC/SOL close prices from Binance |
| `lib/mintFeatures.js` | Aligns events onto daily bars, builds rolling net-flow features |
| `lib/flowSignal.js` | Dynamic lead-lag fusion across flow features -> direction + conviction |
| `backtest.js` | Walk-forward backtest CLI, writes an equity-curve CSV to `out/` |
| `live-preview.js` | Prints the current signal for one or more symbols — read-only, no orders |

## Running it

```bash
npm install
node research/stablecoin-flow/backtest.js BTCUSDT 720
node research/stablecoin-flow/backtest.js SOLUSDT 720
node research/stablecoin-flow/live-preview.js
```

**Note on this sandbox:** `api.etherscan.io` and `api.binance.com` are both blocked by this environment's outbound proxy policy, so this could only be validated offline: `mintFeatures.js` and `flowSignal.js` were smoke-tested against the repo's real historical `btc-daily-binance.csv` (actual BTC prices, 2024-2026) combined with synthetic mint events, including an explicit check that the day-bucketing join matches a manual sum at a checked index. That confirms the math and alignment logic are correct — it does not confirm anything about whether real mint flow actually predicts real returns. That first real test needs to happen on your machine.

## Suggested next steps

1. Run the backtest and look at the mint/burn event count it reports — if it's under ~30 events for the window, treat any Sharpe number as close to meaningless.
2. Compare the equity curve against causal-fusion's on the same symbol/period — if they're highly correlated, the "different risk factor" premise is wrong and this isn't adding diversification.
3. If it looks promising, adding Tron-USDT coverage (majority of real USDT supply) before trusting it further would be the highest-value next step, not more feature engineering on the Ethereum-only data.
