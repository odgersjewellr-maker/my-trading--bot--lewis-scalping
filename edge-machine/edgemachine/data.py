"""Data layer.

Point-in-time OHLCV storage. For crypto, exchange OHLCV is naturally
point-in-time (no restatements/survivorship the way equities have), but we
still store snapshots locally so research is *reproducible* — you replay the
exact bytes you tested on.

Real fetching uses ccxt if it's installed and the network allows it; otherwise
a deterministic synthetic generator lets the whole pipeline run offline so you
can develop and test the machine without a live feed.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

_OHLCV_COLS = ["open", "high", "low", "close", "volume"]


class DataStore:
    """Fetch, persist, and load OHLCV frames keyed by a stable string."""

    def __init__(self, root: str | Path = "data"):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        # Prefer parquet (columnar, typed); fall back to CSV if pyarrow absent.
        try:
            import pyarrow  # noqa: F401
            self._fmt = "parquet"
        except Exception:
            self._fmt = "csv"

    # ------------------------------------------------------------------ paths
    def path(self, key: str) -> Path:
        return self.root / f"{key}.{self._fmt}"

    def _key(self, exchange: str, symbol: str, timeframe: str) -> str:
        safe = f"{exchange}_{symbol}_{timeframe}".replace("/", "-").replace(":", "-")
        return safe.lower()

    # ------------------------------------------------------------------- io
    def save(self, df: pd.DataFrame, key: str) -> Path:
        p = self.path(key)
        if self._fmt == "parquet":
            df.to_parquet(p)
        else:
            df.to_csv(p)
        return p

    def load(self, key: str) -> pd.DataFrame:
        p = self.path(key)
        if not p.exists():
            raise FileNotFoundError(f"No cached data at {p}. Call fetch() first.")
        if self._fmt == "parquet":
            return pd.read_parquet(p)
        return pd.read_csv(p, index_col=0, parse_dates=True)

    # ---------------------------------------------------------------- fetch
    def fetch(
        self,
        exchange: str = "binance",
        symbol: str = "BTC/USDT",
        timeframe: str = "1d",
        limit: int = 1000,
        source: str = "auto",
        cache: bool = True,
        seed: int = 42,
    ) -> pd.DataFrame:
        """Return an OHLCV frame, fetching + caching if not already stored.

        source: 'ccxt' (require live), 'synthetic' (always offline),
                'auto' (try ccxt, fall back to synthetic).
        """
        key = self._key(exchange, symbol, timeframe)
        if cache and self.path(key).exists():
            return self.load(key)

        df = None
        if source in ("ccxt", "auto"):
            try:
                df = self._fetch_ccxt(exchange, symbol, timeframe, limit)
            except Exception as exc:  # network blocked, geo-fenced, not installed…
                if source == "ccxt":
                    raise
                print(f"[data] ccxt fetch failed ({exc!s}); using synthetic data.")
        if df is None:
            df = self._synthetic(limit, timeframe, seed)

        if cache:
            self.save(df, key)
        return df

    def _fetch_ccxt(self, exchange: str, symbol: str, timeframe: str, limit: int) -> pd.DataFrame:
        import ccxt  # optional dependency

        ex = getattr(ccxt, exchange)({"enableRateLimit": True})
        raw = ex.fetch_ohlcv(symbol, timeframe=timeframe, limit=limit)
        df = pd.DataFrame(raw, columns=["ts", *_OHLCV_COLS])
        df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
        return df.set_index("ts")[_OHLCV_COLS].astype(float)

    def _synthetic(self, n: int, timeframe: str, seed: int) -> pd.DataFrame:
        """Deterministic geometric-brownian-motion OHLCV, for offline dev."""
        rng = np.random.default_rng(seed)
        freq = {"1d": "1D", "1h": "1h", "4h": "4h", "15m": "15min"}.get(timeframe, "1D")
        idx = pd.date_range(end=pd.Timestamp.utcnow().normalize(), periods=n, freq=freq)

        mu, sigma = 0.0002, 0.03  # per-bar drift & vol (rough daily-crypto scale)
        rets = rng.normal(mu, sigma, size=n)
        close = 30000.0 * np.exp(np.cumsum(rets))
        open_ = np.concatenate([[close[0]], close[:-1]])
        span = np.abs(rng.normal(0, sigma / 2, size=n)) * close
        high = np.maximum(open_, close) + span
        low = np.minimum(open_, close) - span
        volume = np.abs(rng.normal(1000, 300, size=n))

        return pd.DataFrame(
            {"open": open_, "high": high, "low": low, "close": close, "volume": volume},
            index=idx,
        )
