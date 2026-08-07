"""
TrendFollowingStarter — a trend-following starter strategy for BTC/USDT.

Sibling to TrendPullbackStarter, built after that one's real backtest showed
a mean-reversion ("buy the dip") edge doesn't hold on BTC/USDT 2017-2024:
the asset spent most of that window in a strong uptrend (+1409%), and fading
dips in a market that mostly just keeps climbing gets you out of trades
right before the real move continues.

This strategy buys strength instead of dips:

- Regime filter (4h): same as the pullback strategy — only trade while the
  4h EMA50 > EMA200 (uptrend). Cheap, already-proven-useful context.
- Entry (1h): a Donchian-channel breakout — price closes above its highest
  high of the last 20 candles, i.e. a genuine new local high, with 1h trend
  structure (EMA20 > EMA50) confirming and volume above its recent average
  so the breakout has real participation, not a low-liquidity wick.
- Exit: a *shorter* Donchian channel (10-candle low) — the classic
  "wide entry channel, narrow exit channel" trend-system structure, plus a
  hard exit if 1h trend structure breaks (EMA20 crosses below EMA50) or the
  4h regime flips bearish. No profit-capping ROI table — trend systems make
  their money from the few large winners; capping profit early is exactly
  the failure mode that broke the pullback version's cousin logic.
- Risk: wide ATR-based trailing stop (trends need room to breathe) instead
  of a tight fixed stop, with a hard -12% fallback.
"""

import pandas as pd
from pandas import DataFrame

from freqtrade.strategy import IStrategy, informative, IntParameter, DecimalParameter
from freqtrade.persistence import Trade


class TrendFollowingStarter(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "1h"

    can_short = False

    # Trend systems make money from a few large winners riding a trailing
    # stop, not from capping profit early with an ROI table. Set it high
    # enough that it essentially never fires (a hard runaway-market safety
    # net at +50%, not a target).
    minimal_roi = {"0": 0.50}

    stoploss = -0.12

    trailing_stop = True
    trailing_stop_positive = 0.03
    trailing_stop_positive_offset = 0.05
    trailing_only_offset_is_reached = True

    use_custom_stoploss = True

    process_only_new_candles = True
    startup_candle_count = 210

    # Hyperopt-ready — not hand-tuned.
    donchian_entry_period = IntParameter(10, 40, default=20, space="buy")
    donchian_exit_period = IntParameter(5, 20, default=10, space="sell")
    volume_mult_min = DecimalParameter(0.8, 2.0, default=1.0, decimals=2, space="buy")
    atr_pct_min = DecimalParameter(0.15, 1.0, default=0.30, decimals=2, space="buy")

    @informative("4h")
    def populate_indicators_4h(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["ema50"] = dataframe["close"].ewm(span=50, adjust=False).mean()
        dataframe["ema200"] = dataframe["close"].ewm(span=200, adjust=False).mean()
        dataframe["regime_bullish"] = dataframe["ema50"] > dataframe["ema200"]
        return dataframe

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["regime_bullish_4h"] = (
            dataframe["regime_bullish_4h"].fillna(False).astype(bool)
        )

        # Trend structure on the entry timeframe itself.
        dataframe["ema20"] = dataframe["close"].ewm(span=20, adjust=False).mean()
        dataframe["ema50"] = dataframe["close"].ewm(span=50, adjust=False).mean()

        # Donchian channels. `.shift(1)` excludes the current (still-forming)
        # candle so entries/exits are evaluated against prior confirmed bars,
        # not a channel the current candle itself just created.
        entry_period = self.donchian_entry_period.value
        exit_period = self.donchian_exit_period.value
        dataframe["donchian_high"] = dataframe["high"].rolling(entry_period).max().shift(1)
        dataframe["donchian_low_exit"] = dataframe["low"].rolling(exit_period).min().shift(1)

        dataframe["volume_ma"] = dataframe["volume"].rolling(20).mean()

        # ATR(14) / ATR% for the volatility filter and the trailing stoploss.
        high_low = dataframe["high"] - dataframe["low"]
        high_close = (dataframe["high"] - dataframe["close"].shift()).abs()
        low_close = (dataframe["low"] - dataframe["close"].shift()).abs()
        true_range = pd.concat([high_low, high_close, low_close], axis=1).max(axis=1)
        dataframe["atr"] = true_range.ewm(alpha=1 / 14, adjust=False).mean()
        dataframe["atr_pct"] = (dataframe["atr"] / dataframe["close"]) * 100

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (
                (dataframe["regime_bullish_4h"])
                & (dataframe["close"] > dataframe["donchian_high"])
                & (dataframe["ema20"] > dataframe["ema50"])
                & (dataframe["volume"] > dataframe["volume_ma"] * self.volume_mult_min.value)
                & (dataframe["atr_pct"] > self.atr_pct_min.value)
                & (dataframe["volume"] > 0)
            ),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (
                (dataframe["close"] < dataframe["donchian_low_exit"])
                | (dataframe["ema20"] < dataframe["ema50"])
                | (~dataframe["regime_bullish_4h"])
            ),
            "exit_long",
        ] = 1
        return dataframe

    def custom_stoploss(
        self,
        pair: str,
        trade: Trade,
        current_time,
        current_rate: float,
        current_profit: float,
        **kwargs,
    ) -> float:
        dataframe, _ = self.dp.get_analyzed_dataframe(pair, self.timeframe)
        if dataframe is None or dataframe.empty:
            return self.stoploss

        atr_pct = dataframe["atr_pct"].iloc[-1]
        if pd.isna(atr_pct) or atr_pct <= 0:
            return self.stoploss

        # Wider than the mean-reversion strategy's stop: trend trades need
        # room to breathe through normal pullbacks. ~3x ATR below entry.
        dynamic_stop = -max((3 * atr_pct) / 100, 0.03)
        return max(dynamic_stop, self.stoploss)
