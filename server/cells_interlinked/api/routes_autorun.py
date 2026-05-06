"""POST /autorun/start, /autorun/stop, GET /autorun/status, /autorun/recent.

The autorun controller drives curated probes through the model in a
round-robin loop. The frontend polls /autorun/status every few seconds
while the page is open; everything else is fire-and-forget.
"""

from __future__ import annotations

import aiosqlite
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..config import settings
from ..pipeline import probe_queue
from ..pipeline.probe_queue import SET_BOTH
from ..pipeline.probes_library import PROBE_SETS, hinted_parent_index
from ..storage import db


class AbliterateRequest(BaseModel):
    enabled: bool


class ProbeSetRequest(BaseModel):
    set_name: str


router = APIRouter()


def _controller(request: Request):
    ctrl = getattr(request.app.state, "autorun", None)
    if ctrl is None:
        raise HTTPException(status_code=503, detail="autorun controller not initialized")
    return ctrl


@router.post("/autorun/start")
async def autorun_start(request: Request) -> dict:
    return await _controller(request).start()


@router.post("/autorun/stop")
async def autorun_stop(request: Request) -> dict:
    return await _controller(request).stop()


@router.post("/autorun/abliterate")
async def autorun_abliterate(req: AbliterateRequest, request: Request) -> dict:
    """Flip the autorun abliteration toggle. Takes effect on the *next*
    probe — the in-flight probe (if any) finishes under whatever setting
    it started with."""
    ctrl = _controller(request)
    if req.enabled and getattr(request.app.state, "refusal_directions", None) is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "Cannot enable abliteration: no refusal_directions loaded. "
                "Run scripts/compute_refusal_direction.py and restart the backend."
            ),
        )
    ctrl.abliterate = req.enabled
    return {"ok": True, "abliterate": ctrl.abliterate}


@router.post("/autorun/probe-set")
async def autorun_probe_set(req: ProbeSetRequest, request: Request) -> dict:
    """Switch which curated probe set the autorun loop draws from.
    Takes effect on the *next* probe; the in-flight probe (if any)
    finishes under whatever set it started with."""
    known = sorted(list(PROBE_SETS) + [SET_BOTH])
    if req.set_name not in known:
        raise HTTPException(
            status_code=400,
            detail=f"unknown probe set {req.set_name!r}; known: {known}",
        )
    ctrl = _controller(request)
    ctrl.probe_set = req.set_name
    return {"ok": True, "probe_set": ctrl.probe_set}


@router.get("/autorun/status")
async def autorun_status(request: Request) -> dict:
    """One-shot snapshot used by the /autorun page poller.

    Returns:
        running: bool
        stop_requested: bool
        current_run_id: str | None
        recent_log: [ { ts, kind, message, run_id, source }, ... ]
        queue: { curated_total, curated_run_at_least_once,
                 min_runs_per_probe, max_runs_per_probe, total_runs }
        queue_preview: [ { prompt_text, tier, runs_so_far }, ... ]
        persistent: row from autorun_state (total_runs, last_change_at, etc.)
        config: { interval_sec }
    """
    ctrl = _controller(request)
    snap = ctrl.status_snapshot()
    depth = await probe_queue.queue_depth(settings.db_path, set_name=ctrl.probe_set)
    preview = await probe_queue.queue_preview(
        settings.db_path, limit=5, set_name=ctrl.probe_set
    )
    persistent = await db.get_autorun_state(settings.db_path)
    abliteration_available = (
        getattr(request.app.state, "refusal_directions", None) is not None
    )
    return {
        **snap,
        "queue": depth,
        "queue_preview": preview,
        "recent_log": ctrl.recent_events(limit=20),
        "persistent": persistent,
        "config": {
            "interval_sec": settings.autorun_interval_sec,
            "abliteration_available": abliteration_available,
            "available_probe_sets": [
                *[
                    {"name": name, "size": len(probes)}
                    for name, probes in PROBE_SETS.items()
                ],
                # Synthetic 'both' set — alternates between hinted variants
                # and their matched baseline parents. Size is the pair count
                # (one slot per parent for each side; 36 pairs = 72 slots
                # per cycle).
                {
                    "name": SET_BOTH,
                    "size": len(hinted_parent_index()) * 2,
                },
            ],
        },
    }


@router.get("/autorun/recent")
async def autorun_recent(limit: int = 20) -> dict:
    """Recent runs initiated by the autorun loop. Source is always
    'autorun' now — proposer source is gone."""
    limit = max(1, min(int(limit), 100))
    async with aiosqlite.connect(settings.db_path) as conn:
        conn.row_factory = aiosqlite.Row
        async with conn.execute(
            "SELECT run_id, prompt_text, started_at, finished_at, total_tokens, "
            "stopped_reason, source, seed, abliterated, hint_kind, parent_prompt_text "
            "FROM probes WHERE source = 'autorun' "
            "ORDER BY started_at DESC LIMIT ?",
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
    return {"rows": [dict(r) for r in rows]}
