"""Edge Machine — Phase 0 scaffold.

A minimal, honest research pipeline for discovering, validating, and retiring
trading edges. This package provides the four factory-floor components:

    data     -> point-in-time OHLCV storage (ccxt or synthetic fallback)
    costs    -> a realistic transaction-cost model applied BEFORE you get excited
    backtest -> a vectorized backtester with built-in look-ahead protection
    journal  -> a research journal (every hypothesis logged, including failures)

The pipeline is the product. Individual signals are disposable.
"""

from .costs import CostModel
from .data import DataStore
from .backtest import vectorized_backtest, BacktestResult
from .journal import ResearchJournal
from .gauntlet import run_gauntlet, GauntletResult
from . import metrics, validation

__all__ = [
    "CostModel",
    "DataStore",
    "vectorized_backtest",
    "BacktestResult",
    "ResearchJournal",
    "run_gauntlet",
    "GauntletResult",
    "metrics",
    "validation",
]

__version__ = "0.1.0"
