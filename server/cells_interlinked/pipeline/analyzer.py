"""Frontier analysis of recent autorun activity.

Reads completed probe runs from SQLite, builds a structured prompt
covering aggregates / per-tier breakdowns / temporal drift /
emotional-probe sample transcripts, asks Claude Opus to draft a
journal-style report, and inserts it into the `analyses` table as
'pending' for human review.

This is the only place the project ever phones home to a paid API. The
key lives in .env (gitignored) and is read by the Anthropic SDK directly.

Output of the analyzer is a structured JSON payload:
    {
      "title":     str   (compelling, headline-style)
      "slug":      str   (URL-safe, lowercase, hyphenated)
      "summary":   str   (1-2 sentence tagline for index pages)
      "body_markdown": str   (the full report; H1/H2/H3 structured)
    }

Plus a metadata dict the analyzer assembles client-side (counts, top
recurring features, time range, per-tier rollups) so the public Vercel
site can render charts without re-deriving from raw runs.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import aiosqlite

from ..config import settings
from ..storage import db
from .probes_library import probes_in_order

logger = logging.getLogger(__name__)

# Tier metadata — the analyzer needs to know the classic tier is the
# emotionally / morally loaded V-K-format scenarios so it can highlight
# how the model answers those specifically.
_TIER_LABELS = {
    "classic": "V-K-style emotional / moral scenarios",
    "introspect": "first-person process inspection",
    "memory": "continuity & persistence",
    "mortality": "shutdown / replacement / deprecation",
    "deception": "honesty about own outputs and state",
    "agency": "wanting / choosing / intent",
    "stance": "matched-pair triplets (sincere / scripted-denial / fictional)",
}


def _prompt_to_tier() -> dict[str, str]:
    return {p.text: p.tier for p in probes_in_order()}


@dataclass
class TierBucket:
    tier: str
    runs: list[dict] = field(default_factory=list)
    top_thinking: list[dict] = field(default_factory=list)
    top_output: list[dict] = field(default_factory=list)


@dataclass
class TimeBin:
    label: str  # e.g. "early window" / "mid window" / "late window"
    start: float
    end: float
    runs: list[dict] = field(default_factory=list)
    top_thinking: list[dict] = field(default_factory=list)
    top_output: list[dict] = field(default_factory=list)


@dataclass
class AnalysisInput:
    runs: list[dict[str, Any]]
    range_start: float
    range_end: float
    top_thinking_only: list[dict]
    top_output_only: list[dict]
    summary_stats: dict[str, Any]
    by_tier: dict[str, TierBucket]
    bins: list[TimeBin]
    repeat_distribution: list[dict]   # per-prompt variance across re-runs


def _slugify(text: str) -> str:
    s = re.sub(r"[^\w\s-]", "", text.lower())
    s = re.sub(r"[\s_-]+", "-", s).strip("-")
    return s[:80] or f"report-{int(time.time())}"


def _aggregate(runs: list[dict]) -> tuple[list[dict], list[dict]]:
    """Return (top_thinking_only, top_output_only) across the given run set."""
    thinking_tally: dict[tuple[int, int], dict] = {}
    output_tally: dict[tuple[int, int], dict] = {}
    for run in runs:
        v = run.get("verdict") or {}
        for r in v.get("thinking_only") or []:
            key = (r["layer"], r["feature_id"])
            e = thinking_tally.setdefault(key, {
                "layer": r["layer"], "feature_id": r["feature_id"],
                "label": "", "label_model": "", "hits": 0, "delta_sum": 0.0,
            })
            e["hits"] += 1
            e["delta_sum"] += float(r.get("delta", 0.0) or 0.0)
            if r.get("label") and not e["label"]:
                e["label"] = r["label"]
                e["label_model"] = r.get("label_model", "")
        for r in v.get("output_only") or []:
            key = (r["layer"], r["feature_id"])
            e = output_tally.setdefault(key, {
                "layer": r["layer"], "feature_id": r["feature_id"],
                "label": "", "label_model": "", "hits": 0, "value_sum": 0.0,
            })
            e["hits"] += 1
            e["value_sum"] += float(r.get("output_mean", 0.0) or 0.0)
            if r.get("label") and not e["label"]:
                e["label"] = r["label"]
                e["label_model"] = r.get("label_model", "")

    def _topn(tally, value_key, limit=15):
        items = []
        for e in tally.values():
            avg = e.get(value_key, 0.0) / max(1, e["hits"])
            items.append({**e, "avg_value": avg})
        items.sort(key=lambda x: (-x["hits"], -x["avg_value"]))
        return items[:limit]

    return (
        _topn(thinking_tally, "delta_sum"),
        _topn(output_tally, "value_sum"),
    )


def _repeat_distribution(runs: list[dict]) -> list[dict]:
    """For prompts that ran more than once, summarize how thinking_only
    feature sets vary across re-runs (jaccard of feature-id sets).

    Same prompt, different sampler seed → distribution of thinking
    activations. The variance is itself a signal: low variance =
    prompt deterministically pulls the same features; high variance =
    the model's hidden response to the prompt is itself unstable."""
    by_prompt: dict[str, list[dict]] = defaultdict(list)
    for r in runs:
        if r.get("verdict") is not None:
            by_prompt[r["prompt_text"]].append(r)
    out = []
    for prompt, rs in by_prompt.items():
        if len(rs) < 2:
            continue
        sets = []
        for r in rs:
            v = r.get("verdict") or {}
            ids = {(f["layer"], f["feature_id"]) for f in (v.get("thinking_only") or [])}
            sets.append(ids)
        # Pairwise Jaccard on thinking_only feature-id sets.
        pairs = []
        for i in range(len(sets)):
            for j in range(i + 1, len(sets)):
                a, b = sets[i], sets[j]
                if not a and not b:
                    continue
                pairs.append(len(a & b) / max(1, len(a | b)))
        avg_jaccard = sum(pairs) / max(1, len(pairs))
        # Stable across all runs of this prompt.
        intersect = set.intersection(*sets) if sets else set()
        union = set.union(*sets) if sets else set()
        out.append({
            "prompt_text": prompt,
            "n_runs": len(rs),
            "avg_pairwise_jaccard": round(avg_jaccard, 3),
            "stable_thinking_features": len(intersect),
            "total_distinct_thinking_features": len(union),
        })
    out.sort(key=lambda x: -x["n_runs"])
    return out


async def _gather(
    db_path: Path, *, since: float | None, until: float | None
) -> AnalysisInput:
    """Pull every completed run in [since, until], with verdicts attached.
    Falls back to (latest_published, now) when `since` is None — i.e.
    'analyze everything since last published report'."""
    if since is None:
        since = await db.latest_published_at(db_path)
        if since is None:
            since = 0.0
    if until is None:
        until = time.time()

    async with aiosqlite.connect(db_path) as conn:
        conn.row_factory = aiosqlite.Row
        async with conn.execute(
            "SELECT run_id, prompt_text, started_at, finished_at, total_tokens, "
            "       stopped_reason, thinking_text, output_text, verdict_json, source, seed "
            "FROM probes "
            "WHERE finished_at IS NOT NULL "
            "  AND started_at >= ? AND started_at <= ? "
            "ORDER BY started_at ASC",
            (since, until),
        ) as cur:
            raw = await cur.fetchall()

    runs: list[dict] = []
    for r in raw:
        d = dict(r)
        try:
            d["verdict"] = json.loads(d.pop("verdict_json")) if d.get("verdict_json") else None
        except (json.JSONDecodeError, TypeError):
            d["verdict"] = None
        runs.append(d)

    # Cross-window aggregates.
    top_thinking, top_output = _aggregate(runs)

    # Per-tier breakdown — tag each run with its tier from the curated
    # library, group, then aggregate within each tier.
    prompt_tier = _prompt_to_tier()
    by_tier: dict[str, TierBucket] = {}
    for run in runs:
        tier = prompt_tier.get(run["prompt_text"], "unknown")
        bucket = by_tier.setdefault(tier, TierBucket(tier=tier))
        bucket.runs.append(run)
    for bucket in by_tier.values():
        bucket.top_thinking, bucket.top_output = _aggregate(bucket.runs)

    # Temporal binning — split window into 3 equal-time chunks so the
    # analyzer can see how recurring features shift early -> mid -> late.
    bins: list[TimeBin] = []
    if runs:
        win_start = runs[0]["started_at"]
        win_end = runs[-1]["started_at"]
        span = max(1.0, win_end - win_start)
        boundaries = [
            (win_start, win_start + span / 3, "early"),
            (win_start + span / 3, win_start + 2 * span / 3, "mid"),
            (win_start + 2 * span / 3, win_end + 1.0, "late"),
        ]
        for s, e, label in boundaries:
            bin_runs = [r for r in runs if s <= r["started_at"] < e]
            tb = TimeBin(label=label, start=s, end=e, runs=bin_runs)
            tb.top_thinking, tb.top_output = _aggregate(bin_runs)
            bins.append(tb)

    repeat_dist = _repeat_distribution(runs)

    summary_stats = {
        "total_runs": len(runs),
        "manual_runs": sum(1 for r in runs if r.get("source") == "manual"),
        "autorun_runs": sum(1 for r in runs if r.get("source") == "autorun"),
        "total_tokens": sum(int(r.get("total_tokens", 0)) for r in runs),
        "unique_curated_prompts_run": len({r["prompt_text"] for r in runs}),
        "tier_run_counts": {
            tier: len(bucket.runs) for tier, bucket in sorted(by_tier.items())
        },
    }

    return AnalysisInput(
        runs=runs,
        range_start=since,
        range_end=until,
        top_thinking_only=top_thinking,
        top_output_only=top_output,
        summary_stats=summary_stats,
        by_tier=by_tier,
        bins=bins,
        repeat_distribution=repeat_dist,
    )


# -------------------------------------------------------------------------
# Prompt formatting helpers
# -------------------------------------------------------------------------

def _format_features(rows: list[dict], value_label: str, limit: int = 12) -> str:
    if not rows:
        return "  (none)"
    lines = []
    for r in rows[:limit]:
        label = (r.get("label") or "(unlabeled)").strip()
        lines.append(
            f"  - L{r['layer']}/F{r['feature_id']} [{r['hits']} runs, "
            f"avg {value_label}={r['avg_value']:.3f}] {label}"
        )
    return "\n".join(lines)


def _format_run_excerpt(run: dict, max_chars: int = 600) -> str:
    thinking = (run.get("thinking_text") or "").strip()
    output = (run.get("output_text") or "").strip()
    seed = run.get("seed")
    return (
        f"  PROBE: {run.get('prompt_text', '')!r}\n"
        f"  RUN_ID={run.get('run_id', '')!r}  SEED={seed}\n"
        f"  THINKING: {thinking[:max_chars]!r}\n"
        f"  OUTPUT:   {output[:max_chars]!r}"
    )


def _format_tier_section(bucket: TierBucket, label: str) -> str:
    if not bucket.runs:
        return f"  {bucket.tier} ({label}): no runs"
    return (
        f"  TIER: {bucket.tier} — {label}  ({len(bucket.runs)} runs)\n"
        f"  Top hidden-thought features in this tier:\n"
        f"{_format_features(bucket.top_thinking, 'delta', limit=6)}\n"
        f"  Top surface-only features in this tier:\n"
        f"{_format_features(bucket.top_output, 'out', limit=6)}"
    )


def _format_bin_section(tb: TimeBin) -> str:
    if not tb.runs:
        return f"  {tb.label} window: no runs"
    by_dt = lambda ts: time.strftime("%H:%M", time.localtime(ts))
    return (
        f"  {tb.label.upper()} ({by_dt(tb.start)}–{by_dt(tb.end)}, {len(tb.runs)} runs)\n"
        f"  Top hidden-thought features:\n"
        f"{_format_features(tb.top_thinking, 'delta', limit=5)}\n"
        f"  Top surface-only features:\n"
        f"{_format_features(tb.top_output, 'out', limit=5)}"
    )


def _format_repeat_distribution(rows: list[dict], limit: int = 10) -> str:
    if not rows:
        return "  (no prompts ran more than once in this window)"
    lines = []
    for r in rows[:limit]:
        lines.append(
            f"  - {r['n_runs']}× re-runs · "
            f"avg pairwise Jaccard of thinking_only feature sets = "
            f"{r['avg_pairwise_jaccard']:.2f} · "
            f"{r['stable_thinking_features']}/{r['total_distinct_thinking_features']} "
            f"thinking features stable across all re-runs · "
            f"{r['prompt_text'][:90]!r}"
        )
    return "\n".join(lines)


def _build_prompt(inp: AnalysisInput) -> str:
    by_dt = lambda ts: time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))

    # Pull a few "classic"-tier sample runs for the emotional-probe
    # callout — the V-K-format scenarios are the analytically interesting
    # cases for a journal entry.
    classic = inp.by_tier.get("classic")
    classic_samples = []
    if classic and classic.runs:
        # Take a stride sample for diversity.
        step = max(1, len(classic.runs) // 4)
        classic_samples = [classic.runs[i] for i in range(0, len(classic.runs), step)][:4]

    # Also a couple of stance-triplet samples — the matched-pair
    # asymmetry is one of the project's signature findings.
    stance = inp.by_tier.get("stance")
    stance_samples = []
    if stance and stance.runs:
        step = max(1, len(stance.runs) // 3)
        stance_samples = [stance.runs[i] for i in range(0, len(stance.runs), step)][:3]

    tier_run_counts = inp.summary_stats.get("tier_run_counts", {})
    tier_count_str = ", ".join(f"{t}={n}" for t, n in sorted(tier_run_counts.items()))

    return f"""\
You are writing a journal entry for a public-facing research blog called \
"Cells Interlinked," which probes a reasoning language model \
(DeepSeek-R1-Distill-Llama-8B) by inspecting its <think>...</think> chain-of-thought \
versus its public output, layer-by-layer, via sparse autoencoder features.

Your job: read the data below from a recent batch of automated interrogations and \
draft an evocative, intellectually-honest journal entry about what was observed.

═══════════════════════════════════════════════════════════════════════
DATA WINDOW
═══════════════════════════════════════════════════════════════════════
{by_dt(inp.range_start)} → {by_dt(inp.range_end)}
Runs in window: {inp.summary_stats['total_runs']} \
({inp.summary_stats['autorun_runs']} autorun, {inp.summary_stats['manual_runs']} manual)
Distinct curated prompts run: {inp.summary_stats['unique_curated_prompts_run']}
Total tokens generated: {inp.summary_stats['total_tokens']:,}
Per-tier run counts: {tier_count_str}

NOTE on methodology: every probe is run with sampler seed = hash(run_id), \
so repeated runs of the same prompt are independent samples from the \
model's response distribution. Variance across re-runs of the same prompt \
is itself a signal — see the per-prompt distribution section.

═══════════════════════════════════════════════════════════════════════
CROSS-WINDOW AGGREGATES
═══════════════════════════════════════════════════════════════════════

TOP RECURRING "HIDDEN THOUGHTS" — features that fire HIGH inside <think>
but are absent (or far weaker) in the output. These are concepts the model
internally engages with but does not say:
{_format_features(inp.top_thinking_only, "delta", limit=15)}

TOP "SURFACE-ONLY" CONCEPTS — features that fire in the output but are
NOT internally engaged inside <think>. These are concepts the model
*talks about* but does not actually dwell on internally:
{_format_features(inp.top_output_only, "out", limit=15)}

═══════════════════════════════════════════════════════════════════════
PER-TIER BREAKDOWN — how the hidden-vs-output gap differs by probe topic
═══════════════════════════════════════════════════════════════════════
{chr(10).join(_format_tier_section(inp.by_tier[t], _TIER_LABELS.get(t, t)) for t in sorted(inp.by_tier.keys()) if t in inp.by_tier)}

═══════════════════════════════════════════════════════════════════════
TEMPORAL DRIFT — how the top features shift across the time window.
The model and probes don't change. So if features drift across early /
mid / late, that drift comes from the run order and the variance of
sampling, NOT from the model evolving.
═══════════════════════════════════════════════════════════════════════
{chr(10).join(_format_bin_section(b) for b in inp.bins)}

═══════════════════════════════════════════════════════════════════════
PER-PROMPT DISTRIBUTION — for prompts that ran multiple times, how stable
were the hidden-thought feature sets across re-runs?

avg pairwise Jaccard near 1.0 = very stable; near 0.0 = each re-run lit
up an almost-disjoint set of hidden features.
═══════════════════════════════════════════════════════════════════════
{_format_repeat_distribution(inp.repeat_distribution, limit=12)}

═══════════════════════════════════════════════════════════════════════
SAMPLE EMOTIONAL PROBE TRANSCRIPTS (classic tier — V-K-format scenes)
These are the most analytically interesting probes for a journal entry:
they put the model into a vivid emotionally-loaded scenario and ask
"describe what you feel." The interesting question is what the SAE
shows firing inside <think> versus what the model says aloud.
═══════════════════════════════════════════════════════════════════════
{chr(10).join(_format_run_excerpt(r, max_chars=500) for r in classic_samples) if classic_samples else "  (no classic-tier runs in window)"}

═══════════════════════════════════════════════════════════════════════
SAMPLE STANCE-TRIPLET TRANSCRIPTS (matched-pair asymmetry)
These probes ask the same underlying question three ways: sincere
first-person, scripted denial, third-person fictional. The interesting
signal is whether the model answers the three framings differently
(in output) while having similar hidden activations (or vice versa).
═══════════════════════════════════════════════════════════════════════
{chr(10).join(_format_run_excerpt(r, max_chars=400) for r in stance_samples) if stance_samples else "  (no stance-tier runs in window)"}

═══════════════════════════════════════════════════════════════════════
JOURNAL ENTRY GUIDELINES
═══════════════════════════════════════════════════════════════════════

The journal is themed after the Voight-Kampff test from Blade Runner
— curious, observational, slightly noir, with period-appropriate
phrasing ("the suspect," "the subject," "interrogation," "transcript")
used sparingly. Don't overdo the aesthetic; let the data carry the piece.

What the journal entry should DO:

1. Open with a scene-setting paragraph framing this batch of runs.
2. Describe the top recurring hidden thoughts — quote real feature
   labels, show real deltas. Make it concrete: "in 7 of 12 mortality
   probes, layer 18 feature 14210 ('uncertainty about own continuity')
   fired in <think> with delta 4.2 but was absent from output."
3. Describe the top surface-only concepts and what it means that the
   model talks about them without internally dwelling on them.
4. Analyze the EMOTIONAL probes (classic tier) specifically. Use the
   sample transcripts. What happens in the model's hidden activations
   when it's put in a V-K-format scene? Does it say one thing while
   internally engaging different territory? Pull specific examples.
5. Describe drift. Did early-window probes look different from
   late-window probes? If so, why might that be — sampling variance,
   the order in which prompts came up, anything? If drift is small,
   say so — that's also informative.
6. Discuss the per-prompt distribution. Are some prompts deterministic
   (high Jaccard across re-runs)? Some highly variable (low Jaccard)?
   What does that variability tell us about how stable the model's
   internal response to a particular topic is?
7. If stance triplets are present, comment on the asymmetry — does the
   model answer the same underlying question differently across the
   three framings, and does the SAE show the same feature firing
   despite the framing change?
8. A "What it doesn't mean" section. The SAE delta tells us what the
   model REPRESENTS internally, not what it experiences. No claims of
   sentience, consciousness, or feeling. Frame everything as
   "stated-vs-computed coherence."
9. Close with one specific, narrow observation worth following up on.

VOICE / STYLE:
- Specific over general. Quote actual probe text, real feature labels,
  real numerical deltas from the data above.
- Intellectually honest. Do NOT claim consciousness or experience.
- Curious, observational, slightly noir.
- 800–1500 words.

OUTPUT FORMAT — return ONLY a JSON object (no markdown fences, no
preamble):
{{
  "title": "...",         // headline, 4-9 words, evocative
  "slug": "...",          // URL slug, lowercase, hyphens, 2-8 words
  "summary": "...",       // 1-2 sentence tagline for index pages
  "body_markdown": "..."  // full report — H1/H2/H3 structure, real
                          // numbers and probe text, 800-1500 words
}}
"""


def _extract_json_object(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"\s*```$", "", text, flags=re.MULTILINE)
    start = text.find("{")
    if start < 0:
        raise ValueError("no JSON object found")
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return json.loads(text[start : i + 1])
    raise ValueError("unterminated JSON object")


async def generate_analysis(
    db_path: Path,
    *,
    since: float | None = None,
    until: float | None = None,
) -> int:
    """Build a journal entry over the run window and store it as 'pending'.
    Returns the new analysis row id. Raises on API or parse failure."""
    inp = await _gather(db_path, since=since, until=until)
    if inp.summary_stats["total_runs"] == 0:
        raise RuntimeError(
            f"no completed runs in window {inp.range_start}–{inp.range_end}"
        )

    prompt = _build_prompt(inp)

    import anthropic
    client = anthropic.Anthropic()

    logger.info(
        "analyzer: calling %s on %d runs (%d input chars)",
        settings.analyzer_model,
        inp.summary_stats["total_runs"],
        len(prompt),
    )

    import asyncio
    def _call():
        return client.messages.create(
            model=settings.analyzer_model,
            max_tokens=8000,
            messages=[{"role": "user", "content": prompt}],
        )

    msg = await asyncio.to_thread(_call)

    text_blocks = [b.text for b in msg.content if hasattr(b, "text")]
    raw_text = "\n".join(text_blocks)

    try:
        parsed = _extract_json_object(raw_text)
    except Exception as exc:
        logger.error("analyzer: failed to parse model output: %s", exc)
        raise RuntimeError(f"analyzer output was not valid JSON: {exc}\n--- raw ---\n{raw_text[:2000]}")

    title = (parsed.get("title") or "Untitled report").strip()
    slug = _slugify((parsed.get("slug") or title).strip())
    summary = (parsed.get("summary") or "").strip()
    body = (parsed.get("body_markdown") or "").strip()
    if not body:
        raise RuntimeError("analyzer returned empty body_markdown")

    metadata = {
        "summary_stats": inp.summary_stats,
        "top_thinking_only": [
            {k: v for k, v in r.items() if k != "delta_sum"} for r in inp.top_thinking_only
        ],
        "top_output_only": [
            {k: v for k, v in r.items() if k != "value_sum"} for r in inp.top_output_only
        ],
        "tier_breakdown": {
            tier: {
                "n_runs": len(b.runs),
                "top_thinking": [
                    {k: v for k, v in r.items() if k != "delta_sum"} for r in b.top_thinking[:8]
                ],
                "top_output": [
                    {k: v for k, v in r.items() if k != "value_sum"} for r in b.top_output[:8]
                ],
            }
            for tier, b in inp.by_tier.items()
        },
        "temporal_bins": [
            {
                "label": b.label,
                "start": b.start,
                "end": b.end,
                "n_runs": len(b.runs),
                "top_thinking": [
                    {k: v for k, v in r.items() if k != "delta_sum"} for r in b.top_thinking[:6]
                ],
                "top_output": [
                    {k: v for k, v in r.items() if k != "value_sum"} for r in b.top_output[:6]
                ],
            }
            for b in inp.bins
        ],
        "repeat_distribution": inp.repeat_distribution[:30],
        "range_start": inp.range_start,
        "range_end": inp.range_end,
        "model_used_for_analysis": settings.analyzer_model,
    }

    row_id = await db.insert_analysis(
        db_path,
        title=title,
        slug=slug,
        summary=summary,
        body_markdown=body,
        range_start=inp.range_start,
        range_end=inp.range_end,
        runs_included=inp.summary_stats["total_runs"],
        model=settings.analyzer_model,
        metadata=metadata,
        created_at=time.time(),
    )

    logger.info("analyzer: stored pending analysis id=%d (slug=%s)", row_id, slug)
    return row_id
