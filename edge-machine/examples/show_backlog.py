"""Show the ranked idea backlog, seed it into the research journal, and
regenerate BACKLOG.md.

Run:  python examples/show_backlog.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import DEFAULT as CFG
from edgemachine import ResearchJournal
from edgemachine import backlog as bl


def main() -> None:
    items = bl.ranked()
    print("=" * 78)
    print(f"EDGE MACHINE — Crypto Idea Backlog ({len(items)} ideas, ranked)")
    print("=" * 78)
    print(f"{'#':>2}  {'score':>5}  {'category':<15} idea")
    print("-" * 78)
    for i, e in enumerate(items, 1):
        print(f"{i:>2}  {e.score100:>5}  {e.category:<15} {e.name}")

    # Seed the journal so ideas flow into the pipeline as stage='idea'.
    with ResearchJournal(CFG.journal_path) as jrn:
        ids = bl.seed_journal(jrn)
    print("-" * 78)
    print(f"seeded {len(ids)} ideas into journal at stage='idea' -> {CFG.journal_path}")

    # Regenerate the human-readable doc from the same source of truth.
    out = Path(__file__).resolve().parents[1] / "BACKLOG.md"
    out.write_text(bl.render_markdown())
    print(f"wrote {out}")

    print("\nTop 3 to work first:")
    for e in items[:3]:
        print(f"  • {e.name} — {e.hypothesis}")
    print("\nFeed any of these into run_gauntlet() with a concrete strategy_fn.")


if __name__ == "__main__":
    main()
