# Exchange Netflow — experimental research strategy

**Status: research only. Not wired into `bot.js`, `rules.json`, or live execution. Nothing here places an order.**

Fourth research track. Distinct mechanism from `stablecoin-flow/`: that module tracks *new* stablecoin issuance (primary market). This one tracks *existing* BTC moving into or out of exchange custody — a different kind of on-chain signal about what current holders are doing, not about new money entering.

## The mechanism

BTC moving into a known exchange wallet is conventionally read as "getting ready to sell" (bearish); BTC moving out to cold storage is read as "moving to hold" (bullish). Same dynamic lead-lag method as the other flow modules: instead of hardcoding that convention, a trailing correlation between flow features (raw daily net flow, 3/7/14-day cumulative sums) and next-day BTC returns is re-estimated continuously, so the model can find whichever relationship actually holds empirically — including finding nothing, or finding the opposite of the textbook interpretation.

## Read this before trusting any number from this module

**This tracks exactly one wallet.** `lib/knownWallets.js` currently has a single address: Binance's cold wallet (`34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo`), independently verified across multiple sources as holding ~1.2% of all circulating BTC — chosen specifically because it was verifiable, not because one wallet is an adequate netflow tracker. Commercial on-chain analytics products cluster hundreds of known addresses per exchange. This is a proof of concept for the architecture, not a mature signal.

**Why not more wallets right now:** fabricating a longer address list from memory risks silently wrong data — a wrong address doesn't error, it just produces a netflow number that looks legitimate and means nothing. `lib/knownWallets.js` documents how to responsibly expand the list (cross-reference independent sources like coincarp.com before adding an address) rather than doing that expansion speculatively here.

**Sparse-event risk is worse here than in `stablecoin-flow/`.** One wallet means fewer meaningful flow days than tracking all USDT/USDC issuance. Don't trust a good-looking backtest number without checking the actual event count the way `stablecoin-flow/README.md` already tells you to.

## What data this uses

| Stream | Source | Notes |
|---|---|---|
| BTC wallet flow events | `mempool.space` public API | Free, keyless. Confirmed transactions only — unconfirmed mempool txs are excluded (no reliable timestamp) |
| BTC daily close | `api.binance.com` spot klines | Free, no key |

BTC only — this data source doesn't extend to SOL (Solana's chain and known exchange-wallet clustering are a different integration entirely).

## Files

| File | Purpose |
|---|---|
| `lib/knownWallets.js` | The curated (currently: one) verified exchange address list |
| `lib/mempoolData.js` | Fetches confirmed tx history for a watched address, derives per-tx net flow |
| `lib/exchangeNetflowData.js` | Disk-caches the combined flow event history |
| `lib/priceData.js` | Daily BTC close from Binance |
| `lib/netflowFeatures.js` | Aligns events onto daily bars, rolling net-flow features |
| `lib/flowSignal.js` | Dynamic lead-lag fusion -> direction + conviction |
| `backtest.js` | Walk-forward backtest CLI |
| `live-preview.js` | Current signal, read-only |

## Running it

```bash
npm install
node research/exchange-netflow/backtest.js 365
node research/exchange-netflow/live-preview.js
```

## Note on this sandbox

`mempool.space` and `api.binance.com` are both proxy-blocked here. Validated offline the same way as `stablecoin-flow/`: `netflowFeatures.js`'s day-bucketing join and `flowSignal.js`'s bounds were checked against the repo's real historical BTC price CSV combined with synthetic flow events. The real first run — including whether `mempool.space`'s pagination logic in `mempoolData.js` behaves as expected against the live API — needs to happen on your machine.

## Suggested next steps

1. Run the backtest and check the actual flow-event count before trusting anything.
2. If it shows any promise at all, the highest-value next step is responsibly expanding `knownWallets.js` with more verified addresses — a wider, better-clustered wallet set is a real signal-quality improvement here in a way that more feature engineering on one wallet isn't.
3. Compare against `stablecoin-flow`'s equity curve — if highly correlated, they're not adding independent evidence to a combined portfolio.
