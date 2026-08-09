"""
TrendRegimeBreakout — combines the two validated pieces from the strategies
this repo already tested, specifically to raise trade frequency without
reintroducing the overfitting this project has been trying to avoid:

- The regime gate from SimpleTrendFilter, upgraded from a 200-day to a
  150-day SMA (both were validated together in a 100-300 day robustness
  sweep — 150 had the best return, drawdown, AND Sharpe of the range, not
  a new cherry-picked value).
- The entry/exit mechanics from TrendFollowingStarter (Donchian breakout
  entry, narrower Donchian exit, volume confirmation) — already backtested
  independently against the same real data.

The reasoning for combining them: SimpleTrendFilter alone is high-quality
but low-frequency (~17-19 trades over 6.7 years) because it takes one
position per macro trend and holds it. TrendFollowingStarter alone traded
far more often (402 trades) but was roughly breakeven, and its 4h EMA
regime filter let through more bad-regime trades than the slower, more
robust daily SMA does. Gating the breakout entries with the *better*
regime filter, instead of the noisier 4h one, is the direct hypothesis
being tested here: same trade frequency mechanism, better quality control
on which trends are worth trading breakouts within.
"""

import pandas as pd
from pandas import DataFrame

from freqtrade.strategy import IStrategy, informative, IntParameter, DecimalParameter
from freqtrade.persistence import Trade


class TrendRegimeBreakout(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "1h"
    can_short = False

    minimal_roi = {"0": 0.50}  # not the exit mechanism, same reasoning as TrendFollowingStarter
    stoploss = -0.12

    trailing_stop = True
    trailing_stop_positive = 0.03
    trailing_stop_positive_offset = 0.05
    trailing_only_offset_is_reached = True

    use_custom_stoploss = True

    process_only_new_candles = True
    # The 1d regime uses a 150-day SMA - needs ~3600 1h-candles of real
    # history before the reported backtest start, or regime_bullish_1d
    # would silently be `False` (via the NaN->False safety fallback below)
    # for the whole warmup stretch instead of a hard error, masking the
    # shortfall rather than crashing on it.
    startup_candle_count = 4000

    donchian_entry_period = IntParameter(10, 40, default=20, space="buy")
    donchian_exit_period = IntParameter(5, 20, default=10, space="sell")
    volume_mult_min = DecimalParameter(0.8, 2.0, default=1.0, decimals=2, space="buy")
    atr_pct_min = DecimalParameter(0.15, 1.0, default=0.30, decimals=2, space="buy")

    @informative("1d")
    def populate_indicators_1d(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # 150-day SMA: the best-performing point in the already-validated
        # 100-300 day robustness sweep (best return, drawdown, AND Sharpe),
        # not a new search.
        dataframe["sma150"] = dataframe["close"].rolling(150).mean()
        dataframe["regime_bullish"] = dataframe["close"] > dataframe["sma150"]
        return dataframe

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["regime_bullish_1d"] = (
            dataframe["regime_bullish_1d"].fillna(False).astype(bool)
        )

        dataframe["ema20"] = dataframe["close"].ewm(span=20, adjust=False).mean()
        dataframe["ema50"] = dataframe["close"].ewm(span=50, adjust=False).mean()

        entry_period = self.donchian_entry_period.value
        exit_period = self.donchian_exit_period.value
        dataframe["donchian_high"] = dataframe["high"].rolling(entry_period).max().shift(1)
        dataframe["donchian_low_exit"] = dataframe["low"].rolling(exit_period).min().shift(1)

        dataframe["volume_ma"] = dataframe["volume"].rolling(20).mean()

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
                (dataframe["regime_bullish_1d"])
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
                | (~dataframe["regime_bullish_1d"])
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

        dynamic_stop = -max((3 * atr_pct) / 100, 0.03)
        return max(dynamic_stop, self.stoploss)
