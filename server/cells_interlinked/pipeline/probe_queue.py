"""Probe queue for the autorun loop.

Contract:

    next_probe(db_path) -> ProbeQueueItem | None

Picks the next probe to run. Order of preference:

    1. The next curated probe (from probes_library.PROBES, in TIER_ORDER)
       that has NOT already been used as a `prompt_text` on a probes row.
    2. The oldest unused entry in `generated_probes` (proposer output).
    3. None — caller should trigger the proposer to generate more.

This deliberately exhausts curated probes first. The user's reasoning was:
"start with curated probes round-robin, then proposer generates new
probes per tier when curated exhausted; never repeat probe questions."

A returned item has a `commit(run_id)` callback that the autorun loop
invokes once a run actually starts — for generated probes this marks the
row as used; for curated probes it's a no-op (the `probes` row insert
itself is the dedupe signal).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable

from ..storage import db
from .probes_library import probes_in_order


@dataclass
class ProbeQueueItem:
    prompt_text: str
    source: str            # 'autorun' (curated) | 'proposer' (generated)
    proposer_run_id: int | None
    rationale: str | None  # only set for proposer items, for the live log


def _curated_set() -> list[str]:
    return [p.text for p in probes_in_order()]


async def next_probe(db_path: Path) -> ProbeQueueItem | None:
    used = await db.list_used_prompts(db_path)

    # 1) Curated, in tier order — pick the first unrun one.
    for text in _curated_set():
        if text not in used:
            return ProbeQueueItem(
                prompt_text=text,
                source="autorun",
                proposer_run_id=None,
                rationale=None,
            )

    # 2) Generated probes from the proposer.
    unused = await db.list_unused_generated(db_path, limit=1)
    if unused:
        row = unused[0]
        # Defensive: if a proposer-generated prompt happens to collide with
        # something already in `probes` (shouldn't happen — UNIQUE constraint
        # on prompt_text + we filter against used prompts when generating —
        # but nothing in code prevents a proposer from echoing a curated
        # probe verbatim), mark it used and try again.
        if row["prompt_text"] in used:
            await db.mark_generated_used(
                db_path, gen_id=row["id"], used_at=time.time(), used_run_id="(skipped-dup)"
            )
            return await next_probe(db_path)
        return ProbeQueueItem(
            prompt_text=row["prompt_text"],
            source="proposer",
            proposer_run_id=row["id"],
            rationale=row.get("rationale") or None,
        )

    # 3) Nothing in the queue — caller should kick the proposer.
    return None


async def queue_preview(db_path: Path, limit: int = 5) -> list[dict]:
    """Lookahead used by the /autorun/status endpoint to render the
    'next up' strip in the UI."""
    used = await db.list_used_prompts(db_path)
    out: list[dict] = []
    for text in _curated_set():
        if len(out) >= limit:
            break
        if text not in used:
            out.append({"prompt_text": text, "source": "autorun"})
    if len(out) < limit:
        rows = await db.list_unused_generated(db_path, limit=limit - len(out))
        for r in rows:
            out.append({
                "prompt_text": r["prompt_text"],
                "source": "proposer",
                "rationale": r.get("rationale") or "",
            })
    return out


async def queue_depth(db_path: Path) -> dict:
    """Counts used by the controller to decide whether to kick the proposer."""
    used = await db.list_used_prompts(db_path)
    curated_remaining = sum(1 for t in _curated_set() if t not in used)
    generated_remaining = await db.count_unused_generated(db_path)
    return {
        "curated_remaining": curated_remaining,
        "generated_remaining": generated_remaining,
        "total_remaining": curated_remaining + generated_remaining,
    }


# Type alias so callers don't have to know the shape of the commit hook.
CommitCallback = Callable[[str], Awaitable[None]]


async def commit_used(
    db_path: Path, item: ProbeQueueItem, *, run_id: str
) -> None:
    """Mark the queue item as consumed once a run for it has actually
    started. Curated probes don't need a separate marker — the row in
    `probes` is the dedup signal — but generated probes need their
    `used_at` set so they don't get picked again."""
    if item.source == "proposer" and item.proposer_run_id is not None:
        await db.mark_generated_used(
            db_path,
            gen_id=item.proposer_run_id,
            used_at=time.time(),
            used_run_id=run_id,
        )
