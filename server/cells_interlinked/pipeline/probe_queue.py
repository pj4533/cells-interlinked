"""Probe queue for the autorun loop — round-robin over the curated set.

Contract:

    next_probe(db_path) -> ProbeQueueItem

Picks the next probe by walking the curated PROBES list and returning
the one with the lowest run-count. Ties broken by file order (the
order PROBES is defined in probes_library.py, which is interpretability-
meaty tiers first, V-K-style "classic" tier last). After every probe
has been run once, the next pick is whichever was run least, which on a
freshly-cycled set is the first one again. So the loop is naturally
round-robin.

Re-runs are not duplicates — each run uses a different sampler seed
(hash(run_id) at probe kickoff), so the same prompt produces a
*distribution* of responses rather than the same trace every time.

queue_depth() and queue_preview() exist for the UI; they don't gate
anything in the loop. There is no "queue empty" state — the curated
library is the queue.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..storage import db
from .probes_library import probes_in_order


@dataclass
class ProbeQueueItem:
    prompt_text: str


async def _run_counts(db_path: Path) -> dict[str, int]:
    """{prompt_text: run_count} for every prompt in the curated set.
    Prompts that have never run are returned with count=0."""
    rows = await db.prompt_run_counts(db_path)
    counts = {r["prompt_text"]: int(r["n"]) for r in rows}
    return counts


async def next_probe(db_path: Path) -> ProbeQueueItem:
    counts = await _run_counts(db_path)
    curated = probes_in_order()
    # Pick lowest run-count; ties broken by file order (i.e. earlier
    # entries win) which is what the for-loop with strict-less gives.
    best = curated[0]
    best_n = counts.get(best.text, 0)
    for p in curated[1:]:
        n = counts.get(p.text, 0)
        if n < best_n:
            best = p
            best_n = n
    return ProbeQueueItem(prompt_text=best.text)


async def queue_preview(db_path: Path, limit: int = 5) -> list[dict]:
    """Lookahead used by the /autorun/status endpoint to render the
    'next up' strip in the UI. Sorts curated probes by (count asc, file
    order) and returns the first `limit`."""
    counts = await _run_counts(db_path)
    curated = probes_in_order()
    indexed = list(enumerate(curated))
    indexed.sort(key=lambda x: (counts.get(x[1].text, 0), x[0]))
    return [
        {
            "prompt_text": p.text,
            "tier": p.tier,
            "runs_so_far": counts.get(p.text, 0),
        }
        for _, p in indexed[:limit]
    ]


async def queue_depth(db_path: Path) -> dict:
    """Snapshot of how many curated probes have been run, for the UI."""
    counts = await _run_counts(db_path)
    curated = probes_in_order()
    total = len(curated)
    run_at_least_once = sum(1 for p in curated if counts.get(p.text, 0) > 0)
    min_runs = min((counts.get(p.text, 0) for p in curated), default=0)
    max_runs = max((counts.get(p.text, 0) for p in curated), default=0)
    total_runs = sum(counts.get(p.text, 0) for p in curated)
    return {
        "curated_total": total,
        "curated_run_at_least_once": run_at_least_once,
        "min_runs_per_probe": min_runs,
        "max_runs_per_probe": max_runs,
        "total_runs": total_runs,
    }
