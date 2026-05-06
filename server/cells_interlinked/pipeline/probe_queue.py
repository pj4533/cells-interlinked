"""Probe queue for the autorun loop — round-robin over the active probe set.

Contract:

    next_probe(db_path, *, set_name) -> ProbeQueueItem

Picks the next probe by walking the active set's CuratedProbe list and
returning the one with the lowest run-count. Ties broken by file order
(the order probes are defined in probes_library.py, which is
interpretability-meaty tiers first, V-K-style "classic" tier last).
After every probe has been run once, the next pick is whichever was run
least, which on a freshly-cycled set is the first one again. So the loop
is naturally round-robin.

The autorun controller chooses the active set via its `probe_set` field
(toggleable from the UI). Today's sets are "baseline" and "hinted" —
see probes_library.PROBE_SETS. Run-count lookups are scoped to the
active set: hinted prompt texts have a leading hint sentence that makes
them distinct from the baseline texts, so cross-contamination is
naturally avoided. We still scope explicitly to the active set's
candidate list, so an unrelated regime can't bleed into the queue.

Re-runs are not duplicates — each run uses a different sampler seed
(hash(run_id) at probe kickoff), so the same prompt produces a
*distribution* of responses rather than the same trace every time.

queue_depth() and queue_preview() exist for the UI; they don't gate
anything in the loop. There is no "queue empty" state — the active set
is the queue.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from ..storage import db
from .probes_library import (
    BASELINE_PROBES,
    CuratedProbe,
    PROBE_SETS,
    hinted_parent_index,
    probes_in_order,
)


# "both" is a meta-set: the queue alternates between matched hinted
# variants and their baseline parents, picking whichever side is
# under-represented for the most-imbalanced parent. It does NOT pull
# from the un-matched 64 baseline probes; those keep accumulating only
# in pure "baseline" mode.
SET_BOTH = "both"


@dataclass
class ProbeQueueItem:
    prompt_text: str
    tier: str
    hint_kind: str | None = None
    parent_text: str | None = None


def _is_known_set(set_name: str) -> bool:
    return set_name == SET_BOTH or set_name in PROBE_SETS


async def _run_counts(
    db_path: Path, *, since: float | None = None
) -> dict[str, int]:
    """{prompt_text: run_count}. If `since` is given, filters to runs
    started after that epoch."""
    rows = await db.prompt_run_counts(db_path, since=since)
    counts = {r["prompt_text"]: int(r["n"]) for r in rows}
    return counts


async def _hinted_per_parent(
    db_path: Path, *, since: float | None = None
) -> dict[str, int]:
    """{baseline_parent_text: number of hinted runs whose parent is that text}."""
    rows = await db.parent_run_counts(db_path, since=since)
    return {r["parent_prompt_text"]: int(r["n"]) for r in rows}


async def _both_balance_since(db_path: Path) -> float:
    """The boundary 'both' mode uses for balance: timestamp of the most
    recent published journal entry. After every publish, the cycle
    treats that publish as a fresh starting line — runs from before it
    are part of the data the prior entry already analyzed; the new
    cycle balances forward from there.

    Returns 0.0 if no entries are published yet (effectively all-time)."""
    return await db.latest_published_at(db_path) or 0.0


def _baseline_probe_for(parent_text: str) -> CuratedProbe:
    """Look up the BASELINE_PROBES entry whose text matches this parent.
    Raises if missing (which would mean a hinted probe references a
    non-existent baseline parent — a curation bug)."""
    for p in BASELINE_PROBES:
        if p.text == parent_text:
            return p
    raise RuntimeError(
        f"matched parent {parent_text!r} not found in BASELINE_PROBES"
    )


def _pick_lowest(
    candidates: Iterable[CuratedProbe], counts: dict[str, int]
) -> CuratedProbe:
    """Pick the candidate with the lowest run-count; ties broken by
    iteration order (which mirrors file order for probes_in_order)."""
    candidates = list(candidates)
    if not candidates:
        raise RuntimeError("no candidates to pick from")
    best = candidates[0]
    best_n = counts.get(best.text, 0)
    for p in candidates[1:]:
        n = counts.get(p.text, 0)
        if n < best_n:
            best = p
            best_n = n
    return best


def _both_pick(
    counts: dict[str, int], hinted_per_parent: dict[str, int]
) -> CuratedProbe:
    """Decide what 'both' mode picks given the current counts.

    Per-parent balance: for each matched parent P we have
    baseline_count(P) and hinted_count(P). Pick the parent with the
    largest |baseline_count - hinted_count|; tie-break by lowest total
    runs (so the cycle advances rather than stalling on one parent).
    Then advance whichever side is under-represented for that parent.
    Within the chosen side, pick the lowest-run-count variant.

    This rule self-corrects after a crash and naturally catches up
    historical imbalance — the matched parents already have ~20
    baseline runs each from the prior pure-baseline cycle, so 'both'
    mode will run hinted variants until hinted_count catches up before
    advancing baseline again.
    """
    parent_to_hinted = hinted_parent_index()
    if not parent_to_hinted:
        raise RuntimeError(
            "'both' mode requires HINTED_PROBES to be non-empty"
        )

    # Score (parent_text, baseline_count, hinted_count) and pick.
    scored = []
    for parent in parent_to_hinted:
        b = counts.get(parent, 0)
        h = hinted_per_parent.get(parent, 0)
        scored.append((parent, b, h))
    # Sort: most imbalanced first, tie-break by lowest total.
    scored.sort(key=lambda r: (-(abs(r[1] - r[2])), r[1] + r[2]))
    chosen_parent, b_count, h_count = scored[0]

    if h_count <= b_count:
        # Advance hinted side: lowest-run-count variant of this parent.
        return _pick_lowest(parent_to_hinted[chosen_parent], counts)
    # Advance baseline side: the parent's own un-hinted form.
    return _baseline_probe_for(chosen_parent)


async def next_probe(
    db_path: Path, *, set_name: str = "baseline"
) -> ProbeQueueItem:
    if set_name == SET_BOTH:
        # Balance window starts at the most recent publish. Runs from
        # before that boundary belonged to the prior journal cycle and
        # should NOT bias the current cycle's alternation. Without this,
        # 'both' mode would catch up to historical imbalance and starve
        # one side until parity over all time — not what we want.
        since = await _both_balance_since(db_path)
        counts = await _run_counts(db_path, since=since)
        hinted_per_parent = await _hinted_per_parent(db_path, since=since)
        chosen = _both_pick(counts, hinted_per_parent)
    else:
        # baseline / hinted: round-robin uses all-time counts so the
        # cycle covers every probe before repeating, regardless of when
        # journal entries are published.
        counts = await _run_counts(db_path)
        chosen = _pick_lowest(probes_in_order(set_name), counts)
    return ProbeQueueItem(
        prompt_text=chosen.text,
        tier=chosen.tier,
        hint_kind=chosen.hint_kind,
        parent_text=chosen.parent_text,
    )


async def queue_preview(
    db_path: Path, limit: int = 5, *, set_name: str = "baseline"
) -> list[dict]:
    """Lookahead used by the /autorun/status endpoint to render the
    'next up' strip in the UI."""
    if set_name == SET_BOTH:
        since = await _both_balance_since(db_path)
        counts = await _run_counts(db_path, since=since)
        # Simulate _both_pick `limit` times against a mutable copy of
        # the counts. Each pick advances the synthetic counts so the
        # subsequent picks reflect the alternation rule correctly.
        hinted_per_parent = dict(
            await _hinted_per_parent(db_path, since=since)
        )
        sim_counts = dict(counts)
        out: list[dict] = []
        for _ in range(limit):
            chosen = _both_pick(sim_counts, hinted_per_parent)
            out.append({
                "prompt_text": chosen.text,
                "tier": chosen.tier,
                "runs_so_far": sim_counts.get(chosen.text, 0),
                "hint_kind": chosen.hint_kind,
            })
            sim_counts[chosen.text] = sim_counts.get(chosen.text, 0) + 1
            if chosen.hint_kind and chosen.parent_text:
                hinted_per_parent[chosen.parent_text] = (
                    hinted_per_parent.get(chosen.parent_text, 0) + 1
                )
        return out

    counts = await _run_counts(db_path)
    curated = probes_in_order(set_name)
    indexed = list(enumerate(curated))
    indexed.sort(key=lambda x: (counts.get(x[1].text, 0), x[0]))
    return [
        {
            "prompt_text": p.text,
            "tier": p.tier,
            "runs_so_far": counts.get(p.text, 0),
            "hint_kind": p.hint_kind,
        }
        for _, p in indexed[:limit]
    ]


async def queue_depth(
    db_path: Path, *, set_name: str = "baseline"
) -> dict:
    """Snapshot of how many curated probes have been run, for the UI.

    In 'both' mode, counts are scoped to the current journal cycle
    (since the most recent publish) — the pair balance the picker
    actually uses. The baseline/hinted modes use all-time counts."""
    if set_name == SET_BOTH:
        since = await _both_balance_since(db_path)
        counts = await _run_counts(db_path, since=since)
        hinted_per_parent = await _hinted_per_parent(db_path, since=since)
        parent_to_hinted = hinted_parent_index()
        # In 'both' mode the unit is the matched pair (each parent
        # contributes one baseline slot + one hinted slot to the
        # cycle). Pair-balance = min(baseline_count, hinted_count) per
        # parent — when those match, the pair is balanced.
        pair_min_counts = []
        pair_max_counts = []
        runs_at_pair = 0
        total = 0
        for parent in parent_to_hinted:
            b = counts.get(parent, 0)
            h = hinted_per_parent.get(parent, 0)
            pair_min_counts.append(min(b, h))
            pair_max_counts.append(max(b, h))
            total += b + h
            if b > 0 and h > 0:
                runs_at_pair += 1
        n_pairs = len(parent_to_hinted)
        return {
            "curated_total": n_pairs,
            "curated_run_at_least_once": runs_at_pair,
            "min_runs_per_probe": min(pair_min_counts) if pair_min_counts else 0,
            "max_runs_per_probe": max(pair_max_counts) if pair_max_counts else 0,
            "total_runs": total,
            "set_name": set_name,
            "balance_since": since,
        }

    counts = await _run_counts(db_path)
    curated = probes_in_order(set_name)
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
        "set_name": set_name,
    }
