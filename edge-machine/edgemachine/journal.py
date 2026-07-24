"""Research journal.

Every hypothesis is logged — including the failures. Two reasons:

  1. Retired/rejected edges are training data for your judgment and your next
     ideas (see the post-mortem loop in the plan).
  2. ``n_trials`` — how many variants you tried before reporting a result — is
     what the Validation Gauntlet needs to correct for multiple testing
     (Deflated Sharpe). If it isn't recorded here, that correction is impossible
     later. Logging it now is Phase 0 paying forward to Phase 1.

Backed by stdlib sqlite3 so there are no external dependencies.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

_SCHEMA = """
CREATE TABLE IF NOT EXISTS experiments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              TEXT    NOT NULL,
    name            TEXT    NOT NULL,
    market          TEXT,
    hypothesis      TEXT,
    mechanism       TEXT,           -- who loses and why (required for a real edge)
    params          TEXT,           -- json blob
    n_trials        INTEGER,        -- variants tried (for multiple-testing correction)
    sharpe          REAL,
    oos_sharpe      REAL,
    max_drawdown    REAL,
    cagr            REAL,
    avg_turnover    REAL,
    cost_drag       REAL,
    stage           TEXT,           -- idea|backtest|gauntlet|paper|live|retired
    verdict         TEXT,           -- pass|reject|hold|decayed
    notes           TEXT
);
"""


class ResearchJournal:
    def __init__(self, path: str | Path = "data/research_journal.db"):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.path))
        self._conn.execute(_SCHEMA)
        self._conn.commit()

    def log(
        self,
        name: str,
        *,
        market: str = "",
        hypothesis: str = "",
        mechanism: str = "",
        params: dict | None = None,
        n_trials: int = 1,
        sharpe: float | None = None,
        oos_sharpe: float | None = None,
        max_drawdown: float | None = None,
        cagr: float | None = None,
        avg_turnover: float | None = None,
        cost_drag: float | None = None,
        stage: str = "backtest",
        verdict: str = "hold",
        notes: str = "",
    ) -> int:
        """Insert one experiment row; returns its id."""
        cur = self._conn.execute(
            """INSERT INTO experiments
               (ts, name, market, hypothesis, mechanism, params, n_trials,
                sharpe, oos_sharpe, max_drawdown, cagr, avg_turnover, cost_drag,
                stage, verdict, notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                datetime.now(timezone.utc).isoformat(timespec="seconds"),
                name, market, hypothesis, mechanism,
                json.dumps(params or {}), n_trials,
                sharpe, oos_sharpe, max_drawdown, cagr, avg_turnover, cost_drag,
                stage, verdict, notes,
            ),
        )
        self._conn.commit()
        return int(cur.lastrowid)

    def to_df(self) -> pd.DataFrame:
        """Whole journal as a DataFrame (newest last)."""
        return pd.read_sql_query("SELECT * FROM experiments ORDER BY id", self._conn)

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "ResearchJournal":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
