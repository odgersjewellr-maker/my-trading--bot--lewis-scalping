"""Improvement cadence — KPIs for the machine itself.

Phase 3 isn't only allocation; it's closing the loop. You track not just P&L but
whether the *factory* is healthy: are ideas flowing, is the gauntlet's hit-rate
sane (too high = you're p-hacking or the gauntlet's too weak; too low = weak
sourcing), how many edges are live, how many have been retired.

These read the research journal (see journal.py), which records every item's
stage (idea → gauntlet → paper → live → retired) and verdict.
"""

from __future__ import annotations

import pandas as pd


def machine_kpis(journal_df: pd.DataFrame) -> dict:
    """Compute machine-health KPIs from a research-journal DataFrame."""
    df = journal_df
    gauntlet = df[df["stage"] == "gauntlet"] if "stage" in df else df.iloc[0:0]
    n_gauntlet = len(gauntlet)
    n_pass = int((gauntlet["verdict"] == "pass").sum()) if n_gauntlet else 0
    return {
        "ideas_logged": int((df["stage"] == "idea").sum()) if "stage" in df else 0,
        "gauntlet_runs": n_gauntlet,
        "gauntlet_passes": n_pass,
        "validation_hit_rate": (n_pass / n_gauntlet) if n_gauntlet else float("nan"),
        "live_edges": int((df["stage"] == "live").sum()) if "stage" in df else 0,
        "retired_edges": int((df["stage"] == "retired").sum()) if "stage" in df else 0,
        "by_stage": df["stage"].value_counts().to_dict() if "stage" in df else {},
    }


def render_kpis(journal_df: pd.DataFrame) -> str:
    k = machine_kpis(journal_df)
    hit = k["validation_hit_rate"]
    hit_s = "n/a" if hit != hit else f"{hit*100:.0f}%"
    lines = [
        "MACHINE KPIs (is the factory healthy?)",
        f"  ideas in backlog      : {k['ideas_logged']}",
        f"  gauntlet runs         : {k['gauntlet_runs']}",
        f"  gauntlet passes       : {k['gauntlet_passes']}",
        f"  validation hit-rate   : {hit_s}   "
        f"(too high => p-hacking/weak gauntlet; too low => weak sourcing)",
        f"  live edges            : {k['live_edges']}",
        f"  retired edges         : {k['retired_edges']}",
    ]
    if k["by_stage"]:
        stages = ", ".join(f"{s}:{n}" for s, n in k["by_stage"].items())
        lines.append(f"  by stage              : {stages}")
    return "\n".join(lines)
