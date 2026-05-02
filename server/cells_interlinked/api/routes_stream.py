"""GET /stream/{run_id} — SSE drain of the run's event queue.

Includes a 2KB initial padding comment so Safari and Firefox flush the
response buffer immediately rather than waiting until enough bytes have
accumulated. Without this, browsers other than Chromium can hold every
event back until the entire run completes, which makes the live polygraph
look like it "flashed by" in the final second.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

router = APIRouter()

# 2KB of SSE comment payload. SSE spec: any line beginning with ":" is a
# comment and is ignored by the EventSource parser. We send this as the
# very first chunk so Safari/Firefox flush their internal SSE read buffer
# (which can hold up to ~1KB before delivering anything to JS).
_PADDING = ":" + (" " * 2047) + "\n\n"


@router.get("/stream/{run_id}")
async def stream(run_id: str, request: Request) -> EventSourceResponse:
    state = request.app.state.registry.get(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail="run not found")

    async def gen() -> AsyncIterator[dict]:
        # Flush-buster comment so non-Chromium browsers stop buffering.
        yield {"comment": _PADDING}
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

    return EventSourceResponse(
        gen(),
        headers={
            # Tell intermediaries (and curious dev proxies) not to buffer.
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache, no-transform",
        },
    )
