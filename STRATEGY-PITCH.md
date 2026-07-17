# Candle-Pattern Momentum System — Strategy Pitch

**Asset class:** Crypto spot/perps (BTC, SOL, ETH) · **Timeframe:** Daily candles · **Style:** Long-only momentum with pattern-based exits · **Automation:** Fully systematic, no discretion

---

## Executive summary

A rules-based long-only momentum system built on candlestick pattern recognition, developed and validated on 8 years of BTC daily data and cross-validated out-of-sample on SOL and ETH. The portfolio configuration (three symbols, 10% equity per trade) produced a **1.80 profit factor over 375 trades** with a **6.7% maximum drawdown** — sized specifically to operate inside a prop account's 8–10% drawdown limit.

The edge is simple and explainable: enter on confirmed breakout/continuation patterns in calm uptrends, exit on the first bearish counter-signal instead of a fixed target. Losers are cut in 1–2 days; winners run 5–15 days. Win rate is ~36% by design; the payoff asymmetry carries the expectancy.

What differentiates this submission is the **validation discipline**: every component was selected on a 70/30 chronological train/test split, the full ruleset was re-tested untouched on two symbols it was never tuned on, and the failures are documented alongside the wins.

---

## The strategy

### Entry (any of three setups, evaluated on closed daily candles)

| Setup | Conditions |
|---|---|
| **Trend breakout** | Close above previous candle's high, price above SMA(50), no bearish reversal pattern on the signal candle, no outside bar in the prior 3 candles |
| **Three white soldiers** | Three consecutive strong-bodied advancing green candles |
| **Inside bar in uptrend** | Inside bar above SMA(50), no bearish engulfing / red outside bar in the prior 3 candles |

All entries are **vetoed during high-volatility regimes** (top 30% of trailing-year realized volatility, computed causally). The edge lives in calm trends; volatility spikes were the single largest source of losses in every test.

### Exit

- **Signal exit:** first candle that closes below the previous candle's low (the bearish mirror of the entry logic) — exit at next open
- **Hard stop:** 4–5% below entry (per setup), checked intra-candle with gap handling
- **Time cap:** 15 candles

### Execution mechanics

Signals are computed on closed candles only; entries and signal exits execute at the next candle's open. All backtests include 0.1% per-side fees. No lookahead: every indicator and regime flag is causal.

---

## Validation methodology

1. **Component-level train/test.** Every stop level, veto, exit policy, and regime gate was selected on the first 70% of BTC history and accepted only if it held on the last 30%. Components that improved training but failed the test window (scale-out exits, a "primed breakout" setup) were **rejected and are documented as disabled rules in the config**.
2. **Machine-mined combination check.** A decision-tree miner over all 25 pattern features (train 2018–2024, test 2024–2026) independently converged on the same structure: trend filter first, breakout second, volatility regime as the key gate. Every mined combination held direction out-of-sample; none reversed.
3. **Cross-symbol validation (fully out-of-sample).** The final BTC-tuned ruleset was run **unchanged** on SOL (5 years) and ETH (8 years). Both profitable (PF 1.58 / 1.49). One rule (inside bar) was negative on SOL — flagged below rather than hidden.
4. **Portfolio-level drawdown measurement.** Combined three-symbol equity is stepped daily so correlated simultaneous positions surface in the max drawdown — the number a prop limit actually monitors.

---

## Results

### Single-symbol, full history (fees included)

| | BTC (tuned) | SOL (out-of-sample) | ETH (out-of-sample) |
|---|---|---|---|
| Period | 2018–2026 | 2021–2026 | 2018–2026 |
| Trades | 132 | 93 | 150 |
| Profit factor | 2.54 | 1.58 | 1.49 |
| Avg net/trade | +2.68% | +1.49% | +1.17% |
| Total return | +1,706% | +149% | +205% |
| Max drawdown | 21.5% | 36.6% | 52.7% |

BTC's unseen 2024–2026 test window alone: **PF 3.10, +2.25% avg/trade** — the tuning held on data it never saw.

### Portfolio configuration (BTC+SOL+ETH, 10% of equity per trade)

| Metric | Value |
|---|---|
| Trades/year | ~47 |
| Profit factor | 1.80 |
| CAGR | 8.4% |
| **Max drawdown** | **6.7%** |
| Max concurrent exposure | 30% of account |
| Worst year | 2026 H1: −4.3% |
| Best years | 2020: +20.5%, 2024: +15.5% (at this sizing) |

Sizing scales linearly: 15% per trade ≈ 12.7% CAGR at 9.9% max DD for firms with wider limits.

### Yearly returns, portfolio at 10% sizing

2018 +2.1% · 2019 +14.2% · 2020 +20.5% · 2021 +1.1% · 2022 −0.4% · 2023 +11.6% · 2024 +15.5% · 2025 +9.5% · 2026 H1 −4.3%

No account-threatening year in the sample; the drawdown limit is never approached at this sizing.

---

## Risk profile — read this section first

- **Win rate is ~36%.** Strings of 6–10 consecutive small losses are normal operation, not failure. The system must be judged on 30+ trade windows.
- **Regime dependence.** The edge concentrates in trending markets. 2021-style chop and 2026 H1 produced flat-to-small-negative results. The volatility gate mitigates but does not eliminate this.
- **Residual overfitting risk.** Despite the train/test discipline, many sequential decisions were made on one BTC dataset; the honest planning number is the cross-symbol PF (~1.5–1.8), not BTC's 2.54.
- **Known weak component.** The inside-bar rule was negative on SOL out-of-sample. Recommended deployment runs it BTC-only.
- **Correlation.** All three symbols can (and do) hold positions simultaneously; sizing above assumes that cluster. Daily-loss limits should be checked against a 3-position gap scenario (~3 × sizing × overnight gap).
- **Sample sizes.** The soldiers setup fires ~2×/year/symbol; its per-rule statistics are indicative, not precise.

---

## Infrastructure (already built and running)

- **Live execution stack:** Node.js bot with BitGet spot/futures execution, plus prop-broker adapters (DXtrade and Bybit-v5 API styles) already live-verified on a funded $5k trial (entry → stop → amend → close cycle green)
- **Safety layer:** every entry condition re-checked pre-trade and logged (`safety-check-log.json`); per-day trade caps; position sizing from account equity; paper-trading mode
- **Signal engine parity:** the identical `evaluateRules()` function runs in backtest and live paths — no reimplementation drift
- **Scheduled cloud runs:** GitHub Actions cron per symbol/timeframe, already producing committed audit trails per run
- **Tooling:** full research suite in-repo (`pattern-scanner`, `pattern-pairs`, `pattern-mine`, `exit-sweep`, `squeeze-sweep`, `portfolio-backtest`) — every number in this document is reproducible with one command

## Reproduce every number

```bash
node pattern-backtest.js                       # BTC full backtest
node pattern-backtest.js sol-daily-bitget.csv  # SOL out-of-sample
node pattern-backtest.js eth-daily-bitget.csv  # ETH out-of-sample
node portfolio-backtest.js 0.10                # 3-symbol portfolio, prop sizing
node pattern-mine.js                           # train/test combination mining
node exit-sweep.js                             # exit policy comparison
```

---

## Proposed engagement

1. **Phase 0 (now):** 60–90 day paper/trial run at 10% sizing on the three-symbol book, with pre-registered kill criteria: drawdown > 8% or profit factor < 1.0 after 30 trades
2. **Phase 1:** funded evaluation at identical sizing — no behavior change between paper and eval is the point of full automation
3. **Phase 2:** scale sizing toward the firm's drawdown budget (linear scaling table above); optional intraday variant pending separate validation

*All figures net of 0.1%/side fees, computed on daily closes from Binance (BTC) and BitGet (SOL/ETH) public data. Past performance does not guarantee future results; this document describes a systematic process, not a promise of returns.*
