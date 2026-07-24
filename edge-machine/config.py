"""Central config for the edge machine — plain dataclasses, no external deps.

Edit here (or construct your own) rather than sprinkling magic numbers through
research scripts. Everything downstream reads from a Config instance.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class DataConfig:
    exchange: str = "binance"
    symbol: str = "BTC/USDT"
    timeframe: str = "1d"
    limit: int = 1000
    source: str = "auto"          # 'auto' | 'ccxt' | 'synthetic'
    root: str = "data"


@dataclass
class CostConfig:
    # Rough Binance spot taker defaults; tighten to YOUR venue/fee tier.
    taker_fee_bps: float = 5.0
    half_spread_bps: float = 2.0
    impact_coef_bps: float = 0.0


@dataclass
class BacktestConfig:
    periods_per_year: int = 365   # 365 daily, 8760 hourly, 35040 for 15m
    # Fraction of data reserved as an untouched holdout (look once, ever).
    holdout_frac: float = 0.2


@dataclass
class Config:
    data: DataConfig = field(default_factory=DataConfig)
    cost: CostConfig = field(default_factory=CostConfig)
    backtest: BacktestConfig = field(default_factory=BacktestConfig)
    journal_path: str = "data/research_journal.db"


DEFAULT = Config()
