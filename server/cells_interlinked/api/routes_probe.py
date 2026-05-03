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
from ..pipeline.labels import get_labels
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
        # Fetch human-readable labels for every (layer, feature) referenced in
        # the verdict from Neuronpedia. Cached in SQLite, so subsequent runs
        # touching the same features are instant. Empty string = no label.
        keys = {
            (x.layer, x.feature_id)
            for col in (v.thinking, v.output, v.deltas, v.thinking_only, v.output_only)
            for x in col
        }
        try:
            labels = await get_labels(settings.db_path, list(keys))
        except Exception as exc:
            await state.queue.put({"type": "error", "message": f"label fetch failed: {exc}"})
            labels = {}

        def _attach(rows):
            out = []
            for r in rows:
                d = asdict(r)
                entry = labels.get((r.layer, r.feature_id), {"label": "", "model": ""})
                d["label"] = entry.get("label", "")
                d["label_model"] = entry.get("model", "")
                out.append(d)
            return out

        await state.queue.put({
            "type": "verdict",
            "thinking": _attach(v.thinking),
            "output": _attach(v.output),
            "deltas": _attach(v.deltas),
            "thinking_only": _attach(v.thinking_only),
            "output_only": _attach(v.output_only),
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
        labels=labels if v is not None else None,
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


# Minimum number of distinct runs a feature has to appear in (in the same
# phase-exclusive list) before it qualifies for the cross-run aggregate.
# Below this, "appeared once" tells you nothing beyond the single per-run
# verdict already does.
_AGGREGATE_MIN_HITS = 2

# Cap on rows in each aggregate column so large archives don't dump a
# multi-MB payload.
_AGGREGATE_TOP_N = 60


@router.get("/probes/aggregate")
async def get_aggregate() -> dict:
    """Walk every probe's verdict and tally cross-run patterns.

    Ranks features by HITS (how many distinct runs the feature appeared
    in the relevant phase-exclusive list — Hidden Thoughts for thinking,
    Surface-Only for output), with AVG VALUE as a tiebreaker (mean delta
    for thinking, mean output_mean for output).

    Returns:
        total_runs: int
        thinking_only: list of {layer, feature_id, hits, total_runs,
                                 avg_delta, label, label_model}
        output_only:  list of {layer, feature_id, hits, total_runs,
                                avg_output_mean, label, label_model}
    """
    verdicts = await db.all_verdicts(settings.db_path)
    n_runs = len(verdicts)

    # (layer, feature_id) -> aggregate dict
    thinking_agg: dict[tuple[int, int], dict] = {}
    output_agg: dict[tuple[int, int], dict] = {}

    def _bump(agg, row, value_key):
        key = (row["layer"], row["feature_id"])
        e = agg.setdefault(
            key,
            {"hits": 0, "value_sum": 0.0, "label": "", "label_model": ""},
        )
        e["hits"] += 1
        e["value_sum"] += float(row.get(value_key, 0.0) or 0.0)
        # Keep the first non-empty label we see; if a later run has a
        # better-explainer label, prefer that.
        new_label = (row.get("label") or "").strip()
        new_model = row.get("label_model") or ""
        if new_label:
            from ..pipeline.labels import _rank_explainer
            cur_rank = _rank_explainer(e["label_model"]) if e["label"] else 9999
            new_rank = _rank_explainer(new_model)
            if not e["label"] or new_rank < cur_rank:
                e["label"] = new_label
                e["label_model"] = new_model

    for v in verdicts:
        for r in (v.get("thinking_only") or []):
            _bump(thinking_agg, r, "delta")
        for r in (v.get("output_only") or []):
            _bump(output_agg, r, "output_mean")

    def _rank(agg: dict, value_field_name: str) -> list[dict]:
        out = []
        for (layer, fid), e in agg.items():
            if e["hits"] < _AGGREGATE_MIN_HITS:
                continue
            avg = e["value_sum"] / e["hits"]
            out.append(
                {
                    "layer": layer,
                    "feature_id": fid,
                    "hits": e["hits"],
                    "total_runs": n_runs,
                    value_field_name: avg,
                    "label": e["label"],
                    "label_model": e["label_model"],
                }
            )
        # Sort: hits desc (frequency), then avg value desc (strength).
        out.sort(key=lambda x: (-x["hits"], -x[value_field_name]))
        return out[:_AGGREGATE_TOP_N]

    return {
        "total_runs": n_runs,
        "min_hits": _AGGREGATE_MIN_HITS,
        "thinking_only": _rank(thinking_agg, "avg_delta"),
        "output_only": _rank(output_agg, "avg_output_mean"),
    }


@router.get("/probes/{run_id}")
async def get_probe(run_id: str) -> dict:
    rec = await db.get_probe(settings.db_path, run_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="run not found")
    return rec
