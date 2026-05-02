"""GET /stream/{run_id} — SSE drain of the run's event queue."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

router = APIRouter()


@router.get("/stream/{run_id}")
async def stream(run_id: str, request: Request) -> EventSourceResponse:
    state = request.app.state.registry.get(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail="run not found")

    async def gen() -> AsyncIterator[dict]:
        while True:
            if await request.is_disconnected():
                return
            try:
                evt = await asyncio.wait_for(state.queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                yield {"event": "ping", "data": "{}"}
                continue
            yield {"event": evt.get("type", "message"), "data": json.dumps(evt)}
            if evt.get("type") in ("done", "error"):
                return

    return EventSourceResponse(gen())
