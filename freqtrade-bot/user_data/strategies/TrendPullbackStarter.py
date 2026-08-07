"""
TrendPullbackStarter — a starter Freqtrade strategy for BTC/USDT.

Design intent (not a "guaranteed profit" system — a sane, non-overfit baseline
to validate the pipeline and iterate on):

- Regime filter on a HIGHER timeframe (4h EMA50/EMA200): only look for longs
  while the higher timeframe trend is actually up. This is the piece the old
  1m scalper in this repo was missing, and it's the single highest-leverage
  fix for a mean-reversion/pullback entry — trading pullbacks against the
  higher-timeframe trend is what bleeds accounts in chop.
- Entry timeframe (1h): buy pullbacks (RSI recovering from oversold) only
  while price is above its own EMA50, so the pullback is "buying the dip in
  an uptrend," not catching a falling knife.
- Volatility filter (ATR%): skip entries when ATR% is abnormally low (dead
  market, wide spread/slippage risk relative to expected move) so the bot
  doesn't trade every regime the same way.
- Risk: ATR-based custom stoploss instead of a single fixed percentage, plus
  a hard-cap fallback stoploss and a conservative ROI table.

This is long-only / spot-oriented on purpose for a first pass. Enable
shorting only after you've validated a futures config and margin_mode.
"""

import pandas as pd
from pandas import DataFrame

from freqtrade.strategy import IStrategy, informative, IntParameter, DecimalParameter
from freqtrade.persistence import Trade


class TrendPullbackStarter(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "1h"

    can_short = False

    # Conservative ROI table — take profit sooner as a trade ages.
    minimal_roi = {
        "0": 0.08,
        "60": 0.04,
        "240": 0.02,
        "1440": 0.0,
    }

    # Hard-cap fallback; custom_stoploss (ATR-based) does the real work.
    stoploss = -0.10

    trailing_stop = True
    trailing_stop_positive = 0.015
    trailing_stop_positive_offset = 0.03
    trailing_only_offset_is_reached = True

    use_custom_stoploss = True

    process_only_new_candles = True
    startup_candle_count = 210  # covers the 4h EMA200 once resampled onto 1h

    # Optimizable via `freqtrade hyperopt` — not hand-tuned/curve-fit here.
    rsi_buy_threshold = IntParameter(25, 40, default=35, space="buy")
    rsi_exit_threshold = IntParameter(55, 75, default=65, space="sell")
    atr_pct_min = DecimalParameter(0.15, 1.0, default=0.30, decimals=2, space="buy")

    @informative("4h")
    def populate_indicators_4h(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["ema50"] = dataframe["close"].ewm(span=50, adjust=False).mean()
        dataframe["ema200"] = dataframe["close"].ewm(span=200, adjust=False).mean()
        dataframe["regime_bullish"] = dataframe["ema50"] > dataframe["ema200"]
        return dataframe

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # The informative merge leaves leading NaNs wherever no 4h candle has
        # closed yet, which turns this into a float column and breaks `~`.
        # Treat "unknown regime" as "not bullish."
        dataframe["regime_bullish_4h"] = (
            dataframe["regime_bullish_4h"].fillna(False).astype(bool)
        )

        # Trend filter on the entry timeframe itself.
        dataframe["ema50"] = dataframe["close"].ewm(span=50, adjust=False).mean()

        # RSI(14) for pullback timing.
        delta = dataframe["close"].diff()
        gain = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
        loss = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
        rs = gain / loss.replace(0, pd.NA)
        dataframe["rsi"] = 100 - (100 / (1 + rs))
        dataframe["rsi"] = dataframe["rsi"].fillna(50)
        # Requiring the oversold reading and the upturn on the exact same
        # candle is too narrow to ever fire — real dips bottom on one bar
        # and turn up a bar or two later. Look back over a short window
        # instead of demanding both conditions coincide exactly.
        dataframe["rsi_recent_min"] = dataframe["rsi"].rolling(3).min()

        # ATR(14) and ATR% for the volatility filter and custom stoploss.
        high_low = dataframe["high"] - dataframe["low"]
        high_close = (dataframe["high"] - dataframe["close"].shift()).abs()
        low_close = (dataframe["low"] - dataframe["close"].shift()).abs()
        true_range = pd.concat([high_low, high_close, low_close], axis=1).max(axis=1)
        dataframe["atr"] = true_range.ewm(alpha=1 / 14, adjust=False).mean()
        dataframe["atr_pct"] = (dataframe["atr"] / dataframe["close"]) * 100

        # An RSI(14) dip deep enough to cross below 35 almost always drags
        # price below a same-order-of-magnitude EMA(50) at that exact candle
        # too, since both react to the same recent bars — a hard `close >
        # ema50` gate would veto nearly every real pullback. Give it an
        # ATR-sized buffer instead: "not in an outright breakdown," not
        # "never dipped below the average."
        dataframe["ema50_floor"] = dataframe["ema50"] - dataframe["atr"]

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (
                (dataframe["regime_bullish_4h"])
                & (dataframe["close"] > dataframe["ema50_floor"])
                & (dataframe["rsi_recent_min"] < self.rsi_buy_threshold.value)
                & (dataframe["rsi"] > dataframe["rsi"].shift(1))  # turning up now
                & (dataframe["rsi"] < self.rsi_exit_threshold.value)  # not already back to overbought
                & (dataframe["atr_pct"] > self.atr_pct_min.value)
                & (dataframe["volume"] > 0)
            ),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (
                (dataframe["rsi"] > self.rsi_exit_threshold.value)
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

        # Stop at ~2x ATR below entry, expressed as a negative fraction,
        # never looser than the hard-cap `stoploss`.
        dynamic_stop = -max((2 * atr_pct) / 100, 0.02)
        return max(dynamic_stop, self.stoploss)
