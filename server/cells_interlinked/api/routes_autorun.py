"""POST /autorun/start, /autorun/stop, GET /autorun/status, /autorun/recent.

The autorun controller drives probes through the model in a loop without
human input. The frontend polls /autorun/status every few seconds while
the page is open; everything else is fire-and-forget.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from ..config import settings
from ..pipeline import probe_queue
from ..storage import db

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


@router.get("/autorun/status")
async def autorun_status(request: Request) -> dict:
    """One-shot snapshot used by the /autorun page poller. Bundles
    everything the UI needs so the frontend doesn't fan out into 5
    requests per tick.

    Returns:
        running: bool
        current_run_id: str | None
        proposer: { state, started_at, finished_at, last_count, last_error }
        recent_log: [ { ts, kind, message, run_id, source }, ... ]
        queue: { curated_remaining, generated_remaining, total_remaining }
        queue_preview: [ { prompt_text, source, rationale? }, ... ]
        persistent: row from autorun_state (lifetime_runs, last_change_at, etc.)
        config: { interval_sec, trigger_depth, batch_size }
    """
    ctrl = _controller(request)
    snap = ctrl.status_snapshot()
    depth = await probe_queue.queue_depth(settings.db_path)
    preview = await probe_queue.queue_preview(settings.db_path, limit=5)
    persistent = await db.get_autorun_state(settings.db_path)
    return {
        **snap,
        "queue": depth,
        "queue_preview": preview,
        "recent_log": ctrl.recent_events(limit=20),
        "persistent": persistent,
        "config": {
            "interval_sec": settings.autorun_interval_sec,
            "trigger_depth": settings.proposer_trigger_depth,
            "batch_size": settings.proposer_batch_size,
        },
    }


@router.get("/autorun/recent")
async def autorun_recent(limit: int = 20) -> dict:
    """Recent runs initiated by the autorun loop (source = autorun OR
    proposer). Filtering at the API layer (rather than reusing
    /probes/recent) keeps the autorun page focused on its own activity."""
    limit = max(1, min(int(limit), 100))
    import aiosqlite, json
    async with aiosqlite.connect(settings.db_path) as conn:
        conn.row_factory = aiosqlite.Row
        async with conn.execute(
            "SELECT run_id, prompt_text, started_at, finished_at, total_tokens, "
            "stopped_reason, source, proposer_run_id "
            "FROM probes WHERE source IN ('autorun', 'proposer') "
            "ORDER BY started_at DESC LIMIT ?",
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
    return {"rows": [dict(r) for r in rows]}
