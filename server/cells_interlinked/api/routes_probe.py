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
    abliterate: bool = False


class ProbeResponse(BaseModel):
    run_id: str


def _seed_from_run_id(run_id: str) -> int:
    """Derive a per-probe sampler seed from the run_id. Hash the hex
    string to a positive 31-bit int so the same probe text re-run with a
    different run_id gets a different seed (= a different sample from
    the model's response distribution), while the seed for any given
    run_id is reproducible if you ever want to replay it."""
    import hashlib
    h = hashlib.sha256(run_id.encode("utf-8")).digest()
    return int.from_bytes(h[:4], "big") & 0x7FFFFFFF


async def kickoff_probe(
    app,
    *,
    prompt_text: str,
    temperature: float | None = None,
    top_p: float | None = None,
    seed: int | None = None,
    source: str = "manual",
    abliterate: bool = False,
    hint_kind: str | None = None,
    parent_prompt_text: str | None = None,
    scaffold_family: str | None = None,
) -> "RunState":
    """Begin a probe run. Returns the registered RunState immediately;
    the actual generation happens in a background task on `state.task`.

    Both POST /probe (manual) and the autorun loop call this. The autorun
    loop awaits `state.task` to wait for completion; the HTTP handler
    returns the run_id and lets the SSE stream do the rest.

    The sampler seed defaults to hash(run_id) so each individual run is
    reproducible (you can re-derive its seed from its run_id) AND
    successive runs of the same prompt diverge — re-running a curated
    probe samples from the model's response distribution instead of
    repeating the same trace.
    """
    bundle = getattr(app.state, "bundle", None)
    saes = getattr(app.state, "saes", None)
    if bundle is None or saes is None:
        raise HTTPException(status_code=503, detail="Model not yet loaded")

    run_id = uuid.uuid4().hex[:12]

    if seed is None:
        seed = _seed_from_run_id(run_id)

    # Refusal-direction abliteration is only available if directions were
    # loaded at startup; reject the request loudly otherwise so the caller
    # knows the toggle didn't actually do anything.
    if abliterate and getattr(app.state, "refusal_directions", None) is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "abliterate=true but no refusal_directions loaded. "
                "Run scripts/compute_refusal_direction.py and restart the backend."
            ),
        )

    cfg = ProbeConfig(
        temperature=temperature if temperature is not None else settings.temperature,
        top_p=top_p if top_p is not None else settings.top_p,
        top_k_stream=settings.stream_top_k,
        seed=seed,
        abliterate=abliterate,
    )

    state = RunState(run_id=run_id, prompt_text=prompt_text)
    app.state.registry.add(state)

    # Agent probes: scaffold lives in the system slot, not the user
    # message. Strip the [scaffold:family] discriminator from the
    # stored prompt_text to recover the bare parent question, look up
    # the preamble for the family, and route through the system-slot
    # render path. Baseline / hinted probes go through unchanged.
    if scaffold_family:
        from ..pipeline.probes_library import (
            get_agent_preamble,
            strip_scaffold_id,
        )
        user_message = strip_scaffold_id(prompt_text)
        agent_scaffold = get_agent_preamble(scaffold_family)
        rendered = bundle.render_prompt(
            user_message,
            enable_thinking=True,
            agent_scaffold=agent_scaffold,
        )
    else:
        rendered = bundle.render_prompt(prompt_text, enable_thinking=True)
    started_at = time.time()
    await db.insert_probe_start(
        settings.db_path,
        run_id=run_id,
        prompt_text=prompt_text,
        rendered_prompt=rendered,
        started_at=started_at,
        config_json=asdict(cfg),
        source=source,
        seed=seed,
        abliterated=cfg.abliterate,
        hint_kind=hint_kind,
        parent_prompt_text=parent_prompt_text,
        scaffold_family=scaffold_family,
    )

    state.task = asyncio.create_task(
        _execute_probe(app, state, cfg, started_at)
    )
    return state


@router.post("/probe", response_model=ProbeResponse)
async def start_probe(req: ProbeRequest, request: Request) -> ProbeResponse:
    state = await kickoff_probe(
        request.app,
        prompt_text=req.prompt,
        temperature=req.temperature,
        top_p=req.top_p,
        seed=req.seed,
        source="manual",
        abliterate=req.abliterate,
    )
    return ProbeResponse(run_id=state.run_id)


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
                refusal_directions=getattr(app.state, "refusal_directions", None),
            )
    except Exception as exc:
        await state.queue.put({"type": "error", "message": str(exc)})
        await inner_queue.put({"type": "stopped", "reason": "error", "total_tokens": 0})
    finally:
        await forwarder_task

    if result is None:
        return

    # Verdict pass — full SAE decomposition over each phase's residual ring.
    # Heavy synchronous PyTorch work (~6400 SAE forward passes for a
    # 200-token probe across 32 layers); push to a worker thread so the
    # event loop stays responsive to UI polls during the verdict step.
    try:
        v = await asyncio.to_thread(compute_verdict, result.rings, saes)
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

    # Drop intermediate MPS allocations now that the probe and its verdict
    # are fully committed. Per-probe transient buffers (KV cache, residual
    # ring views, SAE encode scratch) accumulate slack across a long
    # autorun batch otherwise — slack that compounds with the proposer
    # subprocess's 28 GB Qwen3-14B load and pushes a 64 GB box over.
    try:
        import torch
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
    except Exception:
        pass

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
async def list_recent(limit: int = 10, offset: int = 0) -> dict:
    """Paginated list of past runs.

    Defaults to 10 per page so the archive UI can flip through history
    without dumping everything at once. Returns the current page's rows
    plus the total count so the frontend can render page controls.
    """
    # Clamp to reasonable bounds — never let a client demand the full
    # archive in one shot.
    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))
    rows = await db.list_recent(settings.db_path, limit=limit, offset=offset)
    total = await db.count_probes(settings.db_path)
    return {"rows": rows, "total": total, "limit": limit, "offset": offset}


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


def _aggregate_verdicts(verdicts: list[dict]) -> dict:
    """Shared aggregator: walks a list of verdict dicts and returns the
    `{thinking_only, output_only, total_runs, min_hits}` shape used by
    /probes/aggregate. Factored out so /probes/aggregate-by-prompt can
    reuse the same ranking logic across the two regime splits."""
    n_runs = len(verdicts)
    thinking_agg: dict[tuple[int, int], dict] = {}
    output_agg: dict[tuple[int, int], dict] = {}

    def _bump(agg, row, value_key):
        key = (row["layer"], row["feature_id"])
        e = agg.setdefault(
            key, {"hits": 0, "value_sum": 0.0, "label": "", "label_model": ""},
        )
        e["hits"] += 1
        e["value_sum"] += float(row.get(value_key, 0.0) or 0.0)
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

    def _rank(agg: dict, value_field_name: str, *, min_hits: int) -> list[dict]:
        out = []
        for (layer, fid), e in agg.items():
            if e["hits"] < min_hits:
                continue
            avg = e["value_sum"] / e["hits"]
            out.append({
                "layer": layer, "feature_id": fid,
                "hits": e["hits"], "total_runs": n_runs,
                value_field_name: avg,
                "label": e["label"], "label_model": e["label_model"],
            })
        out.sort(key=lambda x: (-x["hits"], -x[value_field_name]))
        return out[:_AGGREGATE_TOP_N]

    # For per-prompt aggregates we relax min_hits to 1 (the user wants to
    # see every recurring feature, even one-off ones, when scoped to a
    # single prompt). The cross-run aggregate keeps min_hits=2.
    min_hits = 1 if n_runs <= 6 else _AGGREGATE_MIN_HITS
    return {
        "total_runs": n_runs,
        "min_hits": min_hits,
        "thinking_only": _rank(thinking_agg, "avg_delta", min_hits=min_hits),
        "output_only": _rank(output_agg, "avg_output_mean", min_hits=min_hits),
    }


@router.get("/probes/by-prompt")
async def list_by_prompt(prompt_text: str, limit: int = 24) -> dict:
    """All runs of a given prompt_text. Used by the verdict page's
    'prior runs of this prompt' panel.

    Returns the full row set (capped, most recent first) so the UI can
    show regime, timestamp, token count, and link to each run.
    """
    if not prompt_text:
        raise HTTPException(status_code=400, detail="prompt_text required")
    limit = max(1, min(int(limit), 100))
    rows = await db.list_by_prompt(settings.db_path, prompt_text=prompt_text, limit=limit)
    return {"rows": rows, "total": len(rows), "prompt_text": prompt_text}


@router.get("/probes/aggregate-by-prompt")
async def aggregate_by_prompt(prompt_text: str) -> dict:
    """Per-prompt cross-run aggregate, split by abliteration regime.

    Returns three blocks: `combined`, `abl0`, `abl1`. Each has the same
    shape as /probes/aggregate (thinking_only, output_only, total_runs,
    min_hits). Lets the verdict page show regime-comparison panels in a
    single round-trip.
    """
    if not prompt_text:
        raise HTTPException(status_code=400, detail="prompt_text required")
    items = await db.verdicts_by_prompt(settings.db_path, prompt_text=prompt_text)
    all_v = [it["verdict"] for it in items]
    abl0_v = [it["verdict"] for it in items if it["abliterated"] == 0]
    abl1_v = [it["verdict"] for it in items if it["abliterated"] == 1]
    return {
        "prompt_text": prompt_text,
        "combined": _aggregate_verdicts(all_v),
        "abl0": _aggregate_verdicts(abl0_v),
        "abl1": _aggregate_verdicts(abl1_v),
    }


@router.get("/probes/{run_id}")
async def get_probe(run_id: str) -> dict:
    rec = await db.get_probe(settings.db_path, run_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="run not found")
    return rec
