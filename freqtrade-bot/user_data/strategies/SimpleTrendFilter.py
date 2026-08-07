"""
SimpleTrendFilter — the simplest, most academically-documented trend rule
there is: be long BTC while price is above its 200-day SMA, flat otherwise
(Faber's "A Quantitative Approach to Tactical Asset Allocation" timing
model, applied here to BTC/USDT daily candles).

This is not trying to beat buy-and-hold's raw return — it structurally
can't, since it's out of the market during some of the recovery after every
whipsaw. The hypothesis being tested is narrower and more credible: does
being flat during sustained downtrends meaningfully cut buy-and-hold's own
drawdown (-83% over 2017-2024) without giving up too much of the upside?
If so, the edge shows up as a much better Sharpe/Calmar ratio, not a bigger
total-return number.

Deliberately as few moving parts as possible - one indicator, one rule -
specifically to avoid the overfitting trap of adding filters until a
backtest looks good on this one historical series.
"""

from pandas import DataFrame

from freqtrade.strategy import IStrategy


class SimpleTrendFilter(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "1d"
    can_short = False

    # The MA crossover itself is the exit mechanism (Faber's model has no
    # separate stop) - this is only a catastrophic-event safety net.
    stoploss = -0.35
    minimal_roi = {"0": 10.0}  # effectively disabled; not the exit mechanism

    trailing_stop = False
    process_only_new_candles = True
    startup_candle_count = 210

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["sma200"] = dataframe["close"].rolling(200).mean()
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (dataframe["close"] > dataframe["sma200"]) & (dataframe["volume"] > 0),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (dataframe["close"] < dataframe["sma200"]),
            "exit_long",
        ] = 1
        return dataframe
