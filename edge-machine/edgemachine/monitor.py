"""Live monitoring, decay detection, and kill switches.

Once an edge passes the gauntlet and goes to paper/live, this layer watches it
against what the backtest promised and pulls the plug on pre-committed rules —
decided *before* deployment, not in the panic of a drawdown.

Three moving parts:

  ExpectedBand      what the backtest said to expect (mean, vol, Sharpe + CI,
                    max drawdown) — the reference the live edge is judged against.
  KillSwitchConfig  the rules, set in advance: drawdown-breach multiple, CUSUM
                    mean-shift thresholds, rolling-Sharpe warning floor, and the
                    position scale to apply on WARN / KILL.
  LiveMonitor       ingests realized returns bar by bar and emits a status
                    (OK / WARN / KILL), a position scale, and the reasons.

Decay detectors:
  * drawdown breach   live DD worse than (mult x backtest max DD)  -> KILL
  * CUSUM             a sustained downward shift in mean return     -> KILL
  * rolling Sharpe    below the warning floor                       -> WARN

A KILL latches: once tripped it stays tripped until a human resets it. You do
not auto-resume a strategy the market just broke.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import metrics


@dataclass
class ExpectedBand:
    """What the backtest promised — the yardstick for live behaviour."""
    mean: float            # per-bar expected return
    vol: float             # per-bar std
    sharpe: float          # annualized
    sharpe_lo: float       # lower bound of Sharpe CI (annualized)
    sharpe_hi: float       # upper bound
    max_drawdown: float    # backtest max drawdown (negative)
    periods_per_year: int

    @classmethod
    def from_returns(cls, returns: pd.Series, periods_per_year: int = 365,
                     n_boot: int = 1000, ci: float = 0.90, seed: int = 0) -> "ExpectedBand":
        r = returns.dropna()
        mean = float(r.mean())
        vol = float(r.std(ddof=1))
        sr = metrics.sharpe(r, periods_per_year)
        rng = np.random.default_rng(seed)
        arr = r.to_numpy()
        boot = np.empty(n_boot)
        for i in range(n_boot):
            s = rng.choice(arr, size=len(arr), replace=True)
            sd = s.std(ddof=1)
            boot[i] = s.mean() / sd * np.sqrt(periods_per_year) if sd > 0 else 0.0
        lo, hi = np.quantile(boot, [(1 - ci) / 2, 1 - (1 - ci) / 2])
        return cls(mean, vol, sr, float(lo), float(hi),
                   metrics.max_drawdown(r), periods_per_year)

    def summary(self) -> str:
        return (f"expected: Sharpe {self.sharpe:.2f} "
                f"[{self.sharpe_lo:.2f}, {self.sharpe_hi:.2f}], "
                f"maxDD {self.max_drawdown*100:.1f}%, "
                f"mean {self.mean*1e4:.2f} bps/bar")


@dataclass
class KillSwitchConfig:
    """Pre-committed rules. Decide these BEFORE going live."""
    dd_breach_mult: float = 1.5       # live DD worse than mult x backtest maxDD -> KILL
    cusum_ref_frac: float = 0.0       # CUSUM target as a fraction of backtest mean.
                                      # 0.0 = fire only on persistent LOSSES (robust to
                                      # in-sample optimism); >0 = stricter, earlier, but
                                      # false-alarms because live underperforms backtest.
    cusum_k: float = 0.5              # CUSUM allowance, in std units (slack)
    cusum_h: float = 8.0             # CUSUM alarm threshold -> KILL. Conservative
                                      # default (~0 false alarms in testing); lower it
                                      # for earlier detection at the cost of more false
                                      # alarms — calibrate on the strategy's own history.
    warn_rolling_window: int = 60     # bars for the rolling-Sharpe warning
    warn_rolling_sharpe: float = 0.0  # rolling Sharpe below this -> WARN
    warn_scale: float = 0.5           # position scale applied on WARN
    kill_scale: float = 0.0           # position scale applied on KILL (flatten)


@dataclass
class MonitorUpdate:
    status: str            # OK | WARN | KILL
    scale: float           # position multiplier to apply going forward
    drawdown: float
    cusum: float
    rolling_sharpe: float | None
    reasons: list = field(default_factory=list)


class LiveMonitor:
    """Feed realized per-bar returns; get status + a position scale each step."""

    def __init__(self, band: ExpectedBand, config: KillSwitchConfig | None = None,
                 name: str = "edge"):
        self.band = band
        self.cfg = config or KillSwitchConfig()
        self.name = name
        self._returns: list[float] = []
        self.cusum = 0.0
        self.equity = 1.0
        self.peak = 1.0
        self.status = "OK"
        self.killed = False
        self.killed_at_index: int | None = None

    def update(self, r: float) -> MonitorUpdate:
        self._returns.append(float(r))
        self.equity *= (1.0 + r)
        self.peak = max(self.peak, self.equity)
        dd = self.equity / self.peak - 1.0

        # One-sided lower CUSUM on standardized returns: accumulates when returns
        # persistently run below a *conservative* reference. Referencing the full
        # (optimistic) backtest mean would false-alarm on every healthy but
        # regressed-to-the-mean live series, so the default reference is 0 —
        # i.e. only persistent LOSSES accumulate the alarm.
        ref = self.band.mean * self.cfg.cusum_ref_frac
        z = (r - ref) / self.band.vol if self.band.vol > 0 else 0.0
        self.cusum = max(0.0, self.cusum - z - self.cfg.cusum_k)

        w = self.cfg.warn_rolling_window
        rolling_sharpe = None
        if len(self._returns) >= w:
            rr = np.asarray(self._returns[-w:])
            sd = rr.std(ddof=1)
            rolling_sharpe = float(rr.mean() / sd * np.sqrt(self.band.periods_per_year)) \
                if sd > 0 else 0.0

        reasons: list[str] = []
        status = "OK"

        # Hard kills (pre-committed) ----------------------------------------
        if dd <= self.band.max_drawdown * self.cfg.dd_breach_mult:
            status = "KILL"
            reasons.append(
                f"drawdown {dd*100:.1f}% breached {self.cfg.dd_breach_mult:g}x "
                f"backtest maxDD ({self.band.max_drawdown*100:.1f}%)")
        if self.cusum > self.cfg.cusum_h:
            status = "KILL"
            reasons.append(
                f"CUSUM {self.cusum:.1f} > {self.cfg.cusum_h:g} — mean shifted down")

        # Soft warning ------------------------------------------------------
        if status == "OK" and rolling_sharpe is not None \
                and rolling_sharpe < self.cfg.warn_rolling_sharpe:
            status = "WARN"
            reasons.append(
                f"rolling Sharpe {rolling_sharpe:.2f} < {self.cfg.warn_rolling_sharpe:g}")

        # Kill latches until a human resets it.
        if self.killed or status == "KILL":
            if not self.killed:
                self.killed_at_index = len(self._returns) - 1
            self.killed = True
            status = "KILL"

        self.status = status
        scale = (self.cfg.kill_scale if status == "KILL"
                 else self.cfg.warn_scale if status == "WARN" else 1.0)
        return MonitorUpdate(status, scale, dd, self.cusum, rolling_sharpe, reasons)

    def reset(self) -> None:
        """Human-in-the-loop clear of a latched kill (keeps equity/history)."""
        self.killed = False
        self.killed_at_index = None
        self.cusum = 0.0
        self.status = "OK"
