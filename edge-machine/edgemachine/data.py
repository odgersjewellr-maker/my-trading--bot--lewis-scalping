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

    # -------------------------------------------------------------- funding
    def fetch_funding_binance(self, symbol: str = "BTCUSDT",
                              intervals: int = 2000) -> tuple[pd.Series, pd.Series, pd.Series]:
        """Fetch real perp funding-rate history + 8h spot & perp closes from Binance.

        Returns ``(funding, spot, basis)`` aligned on funding-settlement times,
        where ``basis = perp_close/spot_close - 1`` (the perp premium the carry
        book is short). Uses the stdlib HTTP client honouring HTTPS_PROXY and the
        proxy CA bundle — no ccxt dependency. Raises on network/policy failure
        (e.g. a geo-fenced or policy-denied environment) so callers can fall back.
        """
        import json
        import os
        import ssl
        import time
        import urllib.request

        ca = os.environ.get("REQUESTS_CA_BUNDLE") or "/root/.ccr/ca-bundle.crt"
        ctx = ssl.create_default_context(cafile=ca) if os.path.exists(ca) \
            else ssl.create_default_context()

        def get(url: str):
            req = urllib.request.Request(url, headers={"User-Agent": "edge-machine/0.1"})
            with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
                return json.load(r)

        # Funding history is capped at 1000 rows/call; page backwards.
        rows, end = [], int(time.time() * 1000)
        while len(rows) < intervals:
            url = (f"https://fapi.binance.com/fapi/v1/fundingRate?symbol={symbol}"
                   f"&limit=1000&endTime={end}")
            batch = get(url)
            if not batch:
                break
            rows = batch + rows
            end = batch[0]["fundingTime"] - 1
            if len(batch) < 1000:
                break
        rows = rows[-intervals:]
        fund = pd.Series(
            [float(r["fundingRate"]) for r in rows],
            index=pd.to_datetime([r["fundingTime"] for r in rows], unit="ms", utc=True),
            name="funding",
        )

        # 8h spot + perp closes; align to funding timestamps and derive basis.
        def closes(base: str) -> pd.Series:
            kl = get(f"{base}?symbol={symbol}&interval=8h&limit=1000")
            return pd.Series(
                [float(k[4]) for k in kl],
                index=pd.to_datetime([k[0] for k in kl], unit="ms", utc=True),
            ).reindex(fund.index, method="nearest")

        spot = closes("https://api.binance.com/api/v3/klines").rename("spot")
        perp = closes("https://fapi.binance.com/fapi/v1/klines")
        basis = (perp / spot - 1.0).rename("basis")
        return fund, spot, basis

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
