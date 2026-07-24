"""Paper-trading harness — drive a strategy forward, bar by bar, under the monitor.

Unlike the vectorized backtester (which sees the whole series at once), this
steps through time the way live trading does: at each bar it holds the position
decided last bar, realizes the return, feeds it to the LiveMonitor, and lets the
kill switch scale (or flatten) the *next* target. That's what makes the kill
switch meaningful — it acts before the next bar's risk is taken.

It's still fed historical data here (the environment has no live feed), but the
control flow is the live one: swap the data iterator for a websocket and the
same monitor/kill logic runs unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from .costs import CostModel
from .monitor import ExpectedBand, KillSwitchConfig, LiveMonitor


@dataclass
class PaperResult:
    log: pd.DataFrame
    killed_at: pd.Timestamp | None
    final_equity: float
    monitor: LiveMonitor

    def summary_text(self) -> str:
        killed = "never" if self.killed_at is None else str(self.killed_at)
        return (f"  final equity : {self.final_equity:.4f} "
                f"({(self.final_equity-1)*100:+.1f}%)\n"
                f"  killed at    : {killed}\n"
                f"  bars WARN    : {int((self.log['status']=='WARN').sum())}\n"
                f"  bars KILL    : {int((self.log['status']=='KILL').sum())}")


def run_paper(
    price: pd.Series,
    strategy_fn,
    band: ExpectedBand,
    *,
    asset_return: pd.Series | None = None,
    holding_cost: pd.Series | None = None,
    cost_model: CostModel | None = None,
    config: KillSwitchConfig | None = None,
    periods_per_year: int = 365,
    name: str = "edge",
    **strat_params,
) -> PaperResult:
    """Step ``strategy_fn`` forward over ``price`` under a LiveMonitor.

    The kill switch scales the *next* target position, so a KILL flattens the
    book from the next bar on. Returns a per-bar log plus the kill timestamp.
    """
    cost_model = cost_model or CostModel()
    mon = LiveMonitor(band, config, name=name)

    target = strategy_fn(price, **strat_params).reindex(price.index).fillna(0.0)
    if asset_return is not None:
        mkt = asset_return.reindex(price.index).fillna(0.0)
    else:
        mkt = price.pct_change(fill_method=None).fillna(0.0)
    hc = None if holding_cost is None else holding_cost.reindex(price.index).fillna(0.0)
    rate = cost_model.rate_per_turnover()

    rows = []
    prev_pos = 0.0
    scale = 1.0
    killed_at = None
    for t in price.index:
        tgt = float(target.loc[t]) * scale          # kill switch scales the new target
        # Return realized this bar comes from the position held INTO it.
        ret = prev_pos * float(mkt.loc[t])
        ret -= rate * abs(tgt - prev_pos)            # turnover cost to reach tgt
        if hc is not None:
            ret -= abs(prev_pos) * float(hc.loc[t])  # holding/slippage cost
        upd = mon.update(ret)
        if killed_at is None and upd.status == "KILL":
            killed_at = t
        rows.append({
            "target": tgt, "held": prev_pos, "ret": ret,
            "equity": mon.equity, "drawdown": upd.drawdown,
            "cusum": upd.cusum, "rolling_sharpe": upd.rolling_sharpe,
            "status": upd.status, "scale": upd.scale,
            "reasons": "; ".join(upd.reasons),
        })
        scale = upd.scale                            # applies to next bar's target
        prev_pos = tgt

    log = pd.DataFrame(rows, index=price.index)
    return PaperResult(log, killed_at, float(mon.equity), mon)
