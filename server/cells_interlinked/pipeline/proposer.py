"""Proposer orchestrator — spawns the Qwen3-14B subprocess and ingests
its output into the `generated_probes` table.

Lives in the parent FastAPI process. The actual model load + inference
happens in a subprocess (cells_interlinked.proposer_worker) so that
Qwen3-14B's ~28 GB of weights are released back to the OS the moment it
exits, leaving the parent's R1-Distill + 32 SAEs alone.

The autorun controller invokes `run_proposer(db_path) -> int` which
returns the count of new probes written. The controller logs that count
into its event log; the UI just sees the queue depth tick up.

---

PHASE 7 (deferred) — targeted-feedback proposer

Today we run "more-like-this": the proposer sees recurring features
across the recent window and writes new probes in the same general
territory. That works, but it's coarse.

The targeted-feedback variant would steer the proposer at SPECIFIC
hidden-thought features the user wants to investigate further:

  1. User clicks a feature row on the verdict page → "investigate this".
  2. Backend writes the (layer, feature_id) into `generated_probes.target_features`
     as part of the next proposer batch's context.
  3. Proposer prompt is augmented: "Generate probes likely to elicit
     STRONG activation of the following SAE features: <feature labels>.
     Vary surface form; do not paraphrase the existing probes that
     already trigger them."
  4. After the runner executes the probe, we measure the actual delta on
     the targeted feature and store the value back on the row. Over time
     this becomes a closed loop: probes that DON'T hit the target get
     down-weighted; the proposer learns which surface forms reliably
     elicit which directions in residual space.

The storage is already in place:
  generated_probes.target_features    JSON list of (layer, feature_id)
  generated_probes.feedback_strategy  'more-like-this' | 'targeted'

When implemented, _gather_context() should split into two paths based
on whether there's a pending targeted-investigation request, and the
proposer prompt template gets a TARGETED FEATURES section.

Out of scope for now; storage scaffolding only.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import time
from collections import Counter
from pathlib import Path

from ..config import settings
from ..storage import db
from .probes_library import probes_in_order

logger = logging.getLogger(__name__)


# Suggested distribution of the {batch_size} new probes across tiers.
# Mirrors the curated library's tier weights, slightly biased toward the
# high-signal interpretability tiers (introspect/agency) over stance.
_DEFAULT_TIER_DISTRIBUTION = {
    "introspect": 5,
    "memory":     3,
    "mortality":  3,
    "deception":  3,
    "agency":     3,
    "stance":     3,
}


def _normalize_distribution(target_n: int) -> dict[str, int]:
    """Scale the default tier weights to sum to target_n (approximately)."""
    base_total = sum(_DEFAULT_TIER_DISTRIBUTION.values())
    if base_total == 0:
        return {}
    scale = target_n / base_total
    out = {k: max(1, round(v * scale)) for k, v in _DEFAULT_TIER_DISTRIBUTION.items()}
    return out


async def _gather_context(db_path: Path, *, n: int) -> dict:
    """Collect the inputs the worker needs:
       - n: target probe count
       - thinking_only / output_only: top recurring features (with labels)
                                      across recent runs, for "more like
                                      this" steering
       - existing_prompts: every probe text the runner has ever seen, so
                           the worker can avoid duplicates"""
    # Recent runs with verdicts.
    recent = await db.list_recent_for_proposer(db_path, limit=12)

    # Tally feature labels across these recent runs. Reuse the same
    # ranking logic the cross-run aggregate uses on the archive page.
    thinking_tally: dict[tuple[int, int], dict] = {}
    output_tally: dict[tuple[int, int], dict] = {}

    def _bump(tally, row):
        key = (row["layer"], row["feature_id"])
        e = tally.setdefault(
            key,
            {"hits": 0, "label": "", "label_model": "", "layer": row["layer"], "feature_id": row["feature_id"]},
        )
        e["hits"] += 1
        if row.get("label") and not e["label"]:
            e["label"] = row["label"]
            e["label_model"] = row.get("label_model", "")

    for run in recent:
        for r in run.get("thinking_only") or []:
            _bump(thinking_tally, r)
        for r in run.get("output_only") or []:
            _bump(output_tally, r)

    def _topn(tally: dict, n_features: int = 12) -> list[dict]:
        return sorted(
            tally.values(),
            key=lambda e: (-e["hits"], -len((e.get("label") or ""))),
        )[:n_features]

    # Existing prompts to avoid: every curated + every generated +
    # every actually-run prompt. The worker is told not to repeat any.
    existing = set()
    for p in probes_in_order():
        existing.add(p.text)
    used = await db.list_used_prompts(db_path)
    existing.update(used)
    unused_gen = await db.list_unused_generated(db_path, limit=500)
    for r in unused_gen:
        existing.add(r["prompt_text"])

    return {
        "model_name": settings.proposer_model,
        "n": n,
        "thinking_only": _topn(thinking_tally),
        "output_only": _topn(output_tally),
        "existing_prompts": sorted(existing),
        "tier_distribution": _normalize_distribution(n),
    }


async def run_proposer(db_path: Path) -> int:
    """Spawn the worker subprocess, wait for it to finish, ingest its
    JSON output, return the count of new probes inserted.

    Raises on subprocess failure (non-zero exit) — the controller catches
    and surfaces in the proposer status panel."""
    n_target = settings.proposer_batch_size
    ctx = await _gather_context(db_path, n=n_target)
    payload = json.dumps(ctx).encode("utf-8")

    logger.info(
        "proposer: spawning worker (target=%d, %d existing prompts to avoid)",
        n_target,
        len(ctx["existing_prompts"]),
    )

    # subprocess invocation: use the same Python interpreter the parent
    # is running on so we get the same .venv and the same transformers.
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "cells_interlinked.proposer_worker",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    # No timeout. The swap-out architecture has the autorun loop
    # blocked on this subprocess by design — there's no other work
    # being starved while we wait, and the runner model is unloaded
    # so we're not squatting on MPS either. If the worker truly hangs,
    # the autorun page will show 'RUNNING' indefinitely; the escape
    # hatch is `pkill -f proposer_worker` (or restart the backend),
    # which makes proc.communicate return non-zero and the controller's
    # except block reloads the runner so autorun can resume.
    stdout_b, stderr_b = await proc.communicate(input=payload)

    stderr_text = stderr_b.decode("utf-8", errors="replace")
    if proc.returncode != 0:
        # The worker might have written partial diagnostics to stderr —
        # surface those upward so the proposer status panel can show them.
        msg = stderr_text.strip().splitlines()[-1] if stderr_text else "unknown"
        logger.error(
            "proposer: worker exited %d — %s",
            proc.returncode,
            stderr_text[-2000:] if stderr_text else "(no stderr)",
        )
        raise RuntimeError(f"proposer worker exited {proc.returncode}: {msg}")

    stdout_text = stdout_b.decode("utf-8", errors="replace").strip()
    if not stdout_text:
        raise RuntimeError("proposer worker produced no output")

    try:
        result = json.loads(stdout_text)
    except json.JSONDecodeError as exc:
        logger.error("proposer: failed to parse worker output: %s", exc)
        raise RuntimeError(f"proposer worker output was not JSON: {exc}")

    probes = result.get("probes") or []
    proposer_model = result.get("model") or settings.proposer_model
    err = result.get("error")
    if err:
        logger.warning("proposer: worker reported error: %s", err)

    # Insert each unique probe. UNIQUE on prompt_text gives us free
    # dedupe at the SQL layer; insert_generated_probe returns None on
    # collision.
    source_run_ids = [r["run_id"] for r in await db.list_recent_for_proposer(db_path, limit=12)]
    inserted = 0
    tier_counts: Counter = Counter()
    now = time.time()
    for p in probes:
        new_id = await db.insert_generated_probe(
            db_path,
            prompt_text=p["text"],
            source_run_ids=source_run_ids,
            proposer_model=proposer_model,
            rationale=f"[{p.get('tier','?')}] {p.get('rationale', '').strip()}",
            target_features=None,           # Phase 7 will populate
            feedback_strategy="more-like-this",
            created_at=now,
        )
        if new_id is not None:
            inserted += 1
            tier_counts[p.get("tier", "?")] += 1

    logger.info(
        "proposer: inserted %d/%d probes — tiers: %s",
        inserted,
        len(probes),
        dict(tier_counts),
    )
    return inserted
