# Edge Machine — Crypto Idea Backlog

> Auto-generated from `edgemachine/backlog.py` (the source of truth). Ranked by the product of six 1-5 priors; the **gauntlet**, not this table, decides what's real. Work the top down.

Scores: **M**echanism · **C**apacity · **E**xecutability · **D**ata · **I**ndependence · Dura**b**ility (1 poor → 5 excellent).

| # | Score | Idea | Category | M | C | E | D | I | b |
|--:|--:|---|---|:-:|:-:|:-:|:-:|:-:|:-:|
| 1 | 48.0 | Perpetual funding carry (delta-neutral) | carry | 5 | 5 | 3 | 5 | 5 | 4 |
| 2 | 38.4 | Dated-futures basis (cash-and-carry) | carry | 5 | 5 | 3 | 4 | 5 | 4 |
| 3 | 24.6 | Funding-extreme directional fade | behavioral | 4 | 4 | 4 | 5 | 4 | 3 |
| 4 | 24.6 | Cross-sectional short-term reversal | cross-sectional | 4 | 4 | 4 | 5 | 4 | 3 |
| 5 | 23.0 | Funding-settlement timestamp effect | structural | 4 | 3 | 4 | 5 | 5 | 3 |
| 6 | 18.4 | Cross-venue funding / premium dislocation | carry | 4 | 4 | 3 | 4 | 5 | 3 |
| 7 | 18.4 | Stablecoin depeg reversion | event | 4 | 4 | 3 | 3 | 5 | 4 |
| 8 | 14.7 | Open-interest / price divergence | behavioral | 3 | 4 | 4 | 4 | 4 | 3 |
| 9 | 13.8 | Cross-sectional momentum (perp basket) | cross-sectional | 3 | 4 | 4 | 5 | 3 | 3 |
| 10 | 11.5 | Time-of-day / session effects | structural | 3 | 3 | 5 | 5 | 4 | 2 |
| 11 | 11.1 | CME weekend gap fill (BTC) | behavioral | 3 | 4 | 4 | 3 | 4 | 3 |
| 12 | 9.8 | Options volatility risk premium | carry | 4 | 4 | 2 | 3 | 4 | 4 |
| 13 | 7.8 | Stablecoin supply / mint impulse | flow | 3 | 5 | 3 | 3 | 3 | 3 |
| 14 | 5.5 | Exchange netflow (on-chain) signal | flow | 3 | 4 | 3 | 2 | 4 | 3 |
| 15 | 4.6 | Liquidation-cascade fade | microstructure | 5 | 2 | 2 | 3 | 4 | 3 |
| 16 | 2.8 | Post-listing drift (major exchange) | event | 3 | 2 | 3 | 3 | 4 | 2 |

---

## Detail cards

### 1. Perpetual funding carry (delta-neutral)  ·  score 48.0  ·  `funding-carry`
- **Category:** carry  |  **Instruments:** BTC, ETH, top perps + their spot  |  **Timeframe:** 8h funding cycle; hold days-weeks
- **Hypothesis:** Long spot / short perp harvests positive funding with little price risk.
- **Mechanism (who loses & why):** Over-leveraged directional longs must PAY funding to keep perps open; the delta-neutral carry trader collects it as the forced counterparty.
- **Data:** Exchange funding-rate history + spot & perp prices (ccxt).
- **How to test:** Backtest funding minus borrow/fees; net of the spread paid to stay neutral. Watch for negative-funding regimes and exchange counterparty risk.
- **Notes:** Crowded but structurally persistent; edge is in venue/fee optimization and sizing.

### 2. Dated-futures basis (cash-and-carry)  ·  score 38.4  ·  `cash-and-carry`
- **Category:** carry  |  **Instruments:** BTC, ETH quarterly futures  |  **Timeframe:** Hold weeks to expiry
- **Hypothesis:** Quarterly futures trade above spot; long spot / short future collects basis to expiry.
- **Mechanism (who loses & why):** Leveraged longs bid dated futures to a premium; the arbitrageur locks the convergence they're forced to eventually give back at settlement.
- **Data:** Dated-futures + spot prices (Binance/OKX/Deribit).
- **How to test:** Annualize basis, subtract fees/spread; compare to funding carry; check backwardation regimes and margin requirements.

### 3. Funding-extreme directional fade  ·  score 24.6  ·  `funding-extreme-fade`
- **Category:** behavioral  |  **Instruments:** BTC, ETH, liquid alt perps  |  **Timeframe:** Signal on 8h funding; hold hours-days
- **Hypothesis:** Extreme positive funding flags crowded longs vulnerable to a squeeze; fade it.
- **Mechanism (who loses & why):** Late crowded longs pay ever-higher funding; when they can't, forced deleveraging cascades. You fade the crowd before the unwind.
- **Data:** Funding-rate history + price (ccxt).
- **How to test:** Rank funding percentile; short top decile / long bottom decile; gauntlet with regime split (trending vs ranging).

### 4. Cross-sectional short-term reversal  ·  score 24.6  ·  `xs-reversal`
- **Category:** cross-sectional  |  **Instruments:** Basket of liquid alt perps  |  **Timeframe:** 1-3 day rebalance
- **Hypothesis:** Over 1-3 days, biggest movers in a perp universe over-extend and revert.
- **Mechanism (who loses & why):** Retail chases short-term winners and dumps losers (overreaction); you provide liquidity to the overreaction and get paid the reversal.
- **Data:** OHLCV for a universe of ~30-50 perps (ccxt).
- **How to test:** Rank N-day returns; long bottom decile / short top decile, market-neutral; gauntlet with turnover & cost stress (this one trades a lot).
- **Notes:** Naturally diversified across names; cost-sensitive.

### 5. Funding-settlement timestamp effect  ·  score 23.0  ·  `funding-timestamp`
- **Category:** structural  |  **Instruments:** BTC, ETH perps  |  **Timeframe:** Minutes around 00/08/16 UTC
- **Hypothesis:** Positioning reshuffles predictably right around funding settlement (00/08/16 UTC).
- **Mechanism (who loses & why):** Traders mechanically dodge paying / angle to collect funding at the snapshot, forcing flow into fixed clock times independent of price.
- **Data:** Minute OHLCV (ccxt) — cheap.
- **How to test:** Event study on returns in the N minutes pre/post settlement; tiny but clean; gauntlet with strict cost modelling.
- **Notes:** Cheap to test, highly independent — good early win to validate the pipeline.

### 6. Cross-venue funding / premium dislocation  ·  score 18.4  ·  `cross-venue-funding`
- **Category:** carry  |  **Instruments:** BTC, ETH perps across Binance/Bybit/OKX  |  **Timeframe:** 8h; hold hours-days
- **Hypothesis:** The same perp's funding/premium differs across exchanges; trade the spread.
- **Mechanism (who loses & why):** Fragmented liquidity means one venue's crowded positioning isn't instantly arbitraged; the richer-funding venue's longs pay the poorer venue's shorts.
- **Data:** Funding & premium across 3-4 venues (ccxt).
- **How to test:** Spread of funding across venues; go short-rich/long-cheap delta-neutral; model transfer/withdrawal frictions honestly.

### 7. Stablecoin depeg reversion  ·  score 18.4  ·  `stable-depeg`
- **Category:** event  |  **Instruments:** USDC, USDT, DAI pairs  |  **Timeframe:** Event-driven (hours-days)
- **Hypothesis:** Temporary depegs in well-backed stables revert to $1.
- **Mechanism (who loses & why):** Panic redeemers dump below peg into thin liquidity; if backing is intact, arbitrage forces convergence back to par.
- **Data:** Stablecoin spot prices + reserve/attestation signals.
- **How to test:** Historical depeg episodes; size for the tail where a depeg is terminal; this is a sell-insurance profile — gauntlet plus explicit ruin analysis.
- **Notes:** Fat left tail (a real de-peg = ruin). Position sizing matters more than signal.

### 8. Open-interest / price divergence  ·  score 14.7  ·  `oi-price-divergence`
- **Category:** behavioral  |  **Instruments:** BTC, ETH, liquid perps  |  **Timeframe:** 1h-4h
- **Hypothesis:** Price up on rising OI (new longs) is fragile; price up on falling OI (short covering) is durable. Trade the implied fragility.
- **Mechanism (who loses & why):** New leveraged longs are weak hands forced out on the next dip; short covering removes forced buyers. OI reveals which is which.
- **Data:** Open-interest history + price (ccxt / exchange APIs).
- **How to test:** Classify bars by sign(ΔOI)×sign(Δprice); test forward returns per quadrant; gauntlet for robustness.

### 9. Cross-sectional momentum (perp basket)  ·  score 13.8  ·  `xs-momentum`
- **Category:** cross-sectional  |  **Instruments:** Basket of liquid perps  |  **Timeframe:** Weekly rebalance
- **Hypothesis:** Over weeks, relative winners keep winning due to under-reaction and flow.
- **Mechanism (who loses & why):** Slow institutional/allocator flows under-react to trends; you front-run the adjustment they're structurally slow to complete.
- **Data:** OHLCV universe (ccxt).
- **How to test:** Rank trailing returns; long top / short bottom, vol-scaled; gauntlet with regime split (momentum dies in choppy regimes).
- **Notes:** Correlated with generic trend-following; watch independence.

### 10. Time-of-day / session effects  ·  score 11.5  ·  `session-effects`
- **Category:** structural  |  **Instruments:** BTC, ETH  |  **Timeframe:** Intraday (hourly buckets)
- **Hypothesis:** Liquidity and drift cluster around Asia/EU/US sessions and CME open/close.
- **Mechanism (who loses & why):** Mechanical rebalancers, CME arb, and regional liquidity create repeatable intraday patterns tied to the clock, not to price.
- **Data:** Hourly/minute OHLCV (ccxt) — cheap.
- **How to test:** Bucket returns by UTC hour & weekday; test stability across years; gauntlet with walk-forward (patterns drift as market matures).
- **Notes:** Easiest to test end-to-end; decays as market matures, so re-validate often.

### 11. CME weekend gap fill (BTC)  ·  score 11.1  ·  `cme-gap`
- **Category:** behavioral  |  **Instruments:** BTC  |  **Timeframe:** Weekend → early week
- **Hypothesis:** BTC gaps between Friday CME close and Sunday/Monday reopen tend to fill.
- **Mechanism (who loses & why):** Spot trades 24/7 while CME is shut; on reopen, basis arbitrageurs are forced to reconcile CME to spot, pulling price back through the gap.
- **Data:** CME BTC futures + spot (Nasdaq Data Link / exchange).
- **How to test:** Measure gap-fill rate & time-to-fill vs gap size; account for gaps that never fill (tail risk); gauntlet.

### 12. Options volatility risk premium  ·  score 9.8  ·  `vol-risk-premium`
- **Category:** carry  |  **Instruments:** BTC, ETH options  |  **Timeframe:** Weekly expiries
- **Hypothesis:** Implied vol exceeds realized on average; systematically sell premium.
- **Mechanism (who loses & why):** Hedgers and lottery-ticket buyers over-pay for optionality; the seller collects the structural premium they're willing to overpay.
- **Data:** Deribit options chain (implied vol) + realized vol.
- **How to test:** IV-minus-RV spread; delta-hedged short-vol backtest; gauntlet plus tail/ruin analysis (short vol blows up in crashes).
- **Notes:** Highest skill/infra barrier; negative skew — respect the tail.

### 13. Stablecoin supply / mint impulse  ·  score 7.8  ·  `stablecoin-supply`
- **Category:** flow  |  **Instruments:** BTC, ETH (market beta)  |  **Timeframe:** Daily-weekly (macro)
- **Hypothesis:** Net USDT/USDC mints add dry powder and precede spot inflows.
- **Mechanism (who loses & why):** Issuers mint to meet incoming fiat demand; that buying power is committed before it reaches the order book — a slow structural lead.
- **Data:** On-chain mint/burn events (Etherscan/Tron/CryptoQuant).
- **How to test:** Aggregate net mint; test lead-lag vs market returns; low frequency so guard against tiny sample; gauntlet.

### 14. Exchange netflow (on-chain) signal  ·  score 5.5  ·  `exchange-netflow`
- **Category:** flow  |  **Instruments:** BTC, ETH, major tokens  |  **Timeframe:** Daily
- **Hypothesis:** Large net inflows to exchanges precede selling; net outflows precede holding.
- **Mechanism (who loses & why):** Whales must move coins onto an exchange before they can sell — an on-chain tell that leaks intent before the market order lands.
- **Data:** On-chain analytics (CryptoQuant / Glassnode / Arkham) — paid.
- **How to test:** Netflow z-score vs forward returns; beware look-ahead in provider data; gauntlet with strict point-in-time discipline.
- **Notes:** Noisy and data is paid/lagged; treat provider timestamps skeptically.

### 15. Liquidation-cascade fade  ·  score 4.6  ·  `liq-cascade-fade`
- **Category:** microstructure  |  **Instruments:** BTC, ETH perps  |  **Timeframe:** Seconds-minutes
- **Hypothesis:** Forced liquidations overshoot; provide liquidity into the wick and fade.
- **Mechanism (who loses & why):** Liquidation engines fire MARKET orders regardless of price — the textbook forced, price-insensitive counterparty. Their impact overshoots fair value.
- **Data:** Liquidation WebSocket (Binance/Bybit) + order book.
- **How to test:** Event study around liq spikes; measure reversion vs adverse selection. Model fills honestly — you're providing liquidity in a fast market.
- **Notes:** Strongest mechanism on the list but low capacity & execution-hard; automate or skip.

### 16. Post-listing drift (major exchange)  ·  score 2.8  ·  `listing-drift`
- **Category:** event  |  **Instruments:** Newly listed tokens  |  **Timeframe:** Hours-days around listing
- **Hypothesis:** Tokens newly listed on a major exchange show predictable early flow/drift.
- **Mechanism (who loses & why):** A Binance/Coinbase listing forces index funds, market makers, and FOMO retail into a fixed window of demand around a scheduled event.
- **Data:** Listing announcements calendar + OHLCV.
- **How to test:** Event study on returns pre/post announcement & listing; small sample so beware overfitting; gauntlet.
