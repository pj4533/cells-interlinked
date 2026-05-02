"""POST /probe, POST /cancel/{run_id}, GET /probes/recent, GET /probes/{run_id}."""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..config import settings
from ..pipeline.generation_loop import ProbeConfig, ProbeResult, run_probe
from ..pipeline.phase_tracker import Phase
from ..pipeline.verdict import compute_verdict
from ..storage import db
from .runs import RunState

router = APIRouter()


class ProbeRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=4000)
    temperature: float | None = None
    top_p: float | None = None
    seed: int | None = None


class ProbeResponse(BaseModel):
    run_id: str


@router.post("/probe", response_model=ProbeResponse)
async def start_probe(req: ProbeRequest, request: Request) -> ProbeResponse:
    app = request.app
    bundle = getattr(app.state, "bundle", None)
    saes = getattr(app.state, "saes", None)
    if bundle is None or saes is None:
        raise HTTPException(status_code=503, detail="Model not yet loaded")

    cfg = ProbeConfig(
        temperature=req.temperature if req.temperature is not None else settings.temperature,
        top_p=req.top_p if req.top_p is not None else settings.top_p,
        top_k_stream=settings.stream_top_k,
        seed=req.seed if req.seed is not None else settings.seed,
    )

    run_id = uuid.uuid4().hex[:12]
    state = RunState(run_id=run_id, prompt_text=req.prompt)
    app.state.registry.add(state)

    rendered = bundle.render_prompt(req.prompt, enable_thinking=True)
    started_at = time.time()
    await db.insert_probe_start(
        settings.db_path,
        run_id=run_id,
        prompt_text=req.prompt,
        rendered_prompt=rendered,
        started_at=started_at,
        config_json=asdict(cfg),
    )

    state.task = asyncio.create_task(
        _execute_probe(app, state, cfg, started_at)
    )
    return ProbeResponse(run_id=run_id)


async def _execute_probe(app, state: RunState, cfg: ProbeConfig, started_at: float) -> None:
    bundle = app.state.bundle
    saes = app.state.saes

    thinking_chunks: list[str] = []
    output_chunks: list[str] = []

    # Tap the queue with a wrapper that mirrors token decodes into chunk lists.
    inner_queue: asyncio.Queue = asyncio.Queue(maxsize=10000)

    async def forwarder() -> None:
        while True:
            evt = await inner_queue.get()
            await state.queue.put(evt)
            if evt.get("type") == "token":
                if evt["phase"] == Phase.THINKING.value:
                    thinking_chunks.append(evt["decoded"])
                elif evt["phase"] == Phase.OUTPUT.value:
                    output_chunks.append(evt["decoded"])
            if evt.get("type") == "stopped":
                break

    forwarder_task = asyncio.create_task(forwarder())

    result: ProbeResult | None = None
    try:
        async with app.state.registry.lock:
            result = await run_probe(
                bundle=bundle,
                saes=saes,
                prompt_text=state.prompt_text,
                cfg=cfg,
                cancel_event=state.cancel_event,
                queue=inner_queue,
            )
    except Exception as exc:
        await state.queue.put({"type": "error", "message": str(exc)})
        await inner_queue.put({"type": "stopped", "reason": "error", "total_tokens": 0})
    finally:
        await forwarder_task

    if result is None:
        return

    # Verdict pass — full SAE decomposition over each phase's residual ring.
    try:
        v = compute_verdict(result.rings, saes)
    except Exception as exc:
        await state.queue.put({"type": "error", "message": f"verdict failed: {exc}"})
        v = None

    if v is not None:
        await state.queue.put({
            "type": "verdict",
            "thinking": [asdict(x) for x in v.thinking],
            "output": [asdict(x) for x in v.output],
            "deltas": [asdict(x) for x in v.deltas],
            "thinking_only": [asdict(x) for x in v.thinking_only],
            "output_only": [asdict(x) for x in v.output_only],
            "summary_stats": v.summary_stats,
        })

    await db.update_probe_finish(
        settings.db_path,
        run_id=state.run_id,
        finished_at=time.time(),
        total_tokens=result.total_tokens,
        stopped_reason=result.stopped_reason,
        thinking_text="".join(thinking_chunks),
        output_text="".join(output_chunks),
        verdict=v,
    )

    await state.queue.put({"type": "done"})
    state.completed = True


@router.post("/cancel/{run_id}")
async def cancel_probe(run_id: str, request: Request) -> dict:
    state = request.app.state.registry.get(run_id)
    if state is None:
        raise HTTPException(status_code=404, detail="run not found")
    state.cancel_event.set()
    return {"ok": True}


@router.get("/probes/recent")
async def list_recent() -> list:
    return await db.list_recent(settings.db_path, limit=50)


@router.get("/probes/{run_id}")
async def get_probe(run_id: str) -> dict:
    rec = await db.get_probe(settings.db_path, run_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="run not found")
    return rec
