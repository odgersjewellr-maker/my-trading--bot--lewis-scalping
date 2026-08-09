"""
SimpleTrendFilterPyramid — SimpleTrendFilter's exact regime rule and exit
discipline, plus one addition: scale into the position on confirmed
pullbacks within an already-open trend, instead of committing full size on
day one of the regime flip.

Why this is structurally different from TrendRegimeBreakout (which failed):
TrendRegimeBreakout added a *faster entry AND faster exit* on top of the
regime filter, and the faster exit is what destroyed the edge - cutting
winners on ordinary pullbacks instead of letting the regime-flip exit do
its job. This strategy changes nothing about when a trade closes. The
regime-flip exit (`close < SMA`) from SimpleTrendFilter is untouched. The
only new behavior is adding *more capital to a trade already validated by
the regime filter*, which is a sizing decision, not a new trade with its
own entry/exit logic.

Add-on rule, deliberately simple and event-driven rather than continuous:
after entry, if price pulls back at least 8% from its highest close since
entry and then closes higher than the prior candle (turning back up), add
another tranche - capped at 3 total adds per trade, and at least 20 days
apart so this reacts to real pullback-and-bounce events, not everyday
noise.

Sizing note: with `stake_amount: "unlimited"` and `max_open_trades: 1`,
Freqtrade commits the ENTIRE account balance to the initial entry, leaving
nothing free for `adjust_trade_position` to add with (confirmed by
instrumenting a first attempt at this strategy - available capital for
adds was ~$0.01). `custom_stake_amount` below reserves room up front by
sizing the initial entry at 1/(1+max adds), so total exposure across the
initial entry plus all adds firing still tops out at roughly the same
total capital the non-pyramiding version would have committed on day one
- this changes *when* capital gets deployed, not how much.
"""

from pandas import DataFrame

from freqtrade.strategy import IStrategy
from freqtrade.persistence import Trade

SMA_PERIOD = 150
PULLBACK_THRESHOLD = 0.08
MIN_DAYS_BETWEEN_ADDS = 20
MAX_ADDS = 3


class SimpleTrendFilterPyramid(IStrategy):
    INTERFACE_VERSION = 3

    timeframe = "1d"
    can_short = False

    stoploss = -0.35
    minimal_roi = {"0": 10.0}

    trailing_stop = False
    process_only_new_candles = True
    startup_candle_count = 210

    position_adjustment_enable = True
    max_entry_position_adjustment = MAX_ADDS

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe["sma"] = dataframe["close"].rolling(SMA_PERIOD).mean()
        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (dataframe["close"] > dataframe["sma"]) & (dataframe["volume"] > 0),
            "enter_long",
        ] = 1
        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (dataframe["close"] < dataframe["sma"]),
            "exit_long",
        ] = 1
        return dataframe

    def custom_stake_amount(
        self,
        pair: str,
        current_time,
        current_rate: float,
        proposed_stake: float,
        min_stake,
        max_stake: float,
        leverage: float,
        entry_tag,
        side: str,
        **kwargs,
    ) -> float:
        return proposed_stake / (1 + MAX_ADDS)

    def adjust_trade_position(
        self,
        trade: Trade,
        current_time,
        current_rate: float,
        current_profit: float,
        min_stake,
        max_stake: float,
        current_entry_rate: float,
        current_exit_rate: float,
        current_entry_profit: float,
        current_exit_profit: float,
        **kwargs,
    ):
        dataframe, _ = self.dp.get_analyzed_dataframe(trade.pair, self.timeframe)
        if dataframe is None or len(dataframe) < 2:
            return None

        candles_since_entry = dataframe[dataframe["date"] > trade.open_date_utc]
        if len(candles_since_entry) < 2:
            return None

        highest_close = candles_since_entry["close"].max()
        pullback = (highest_close - current_rate) / highest_close
        turning_up = candles_since_entry["close"].iloc[-1] > candles_since_entry["close"].iloc[-2]

        if pullback < PULLBACK_THRESHOLD or not turning_up:
            return None

        if trade.orders:
            last_order_date = max(o.order_date_utc for o in trade.orders if o.order_date_utc)
            days_since_last_order = (current_time - last_order_date).days
            if days_since_last_order < MIN_DAYS_BETWEEN_ADDS:
                return None

        # Match the initial entry's tranche size, capped by what's actually
        # available (adjust_trade_position's max_stake already reflects free
        # wallet balance, unlike the fixed reservation custom_stake_amount
        # used at entry time).
        add_stake = trade.stake_amount
        if min_stake is not None and add_stake < min_stake:
            return None
        return min(add_stake, max_stake)
