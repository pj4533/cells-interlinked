"""Frontier analysis of recent autorun activity.

Reads the last N days of probe runs (with verdicts) from SQLite, builds
a structured prompt, asks Claude Opus to draft a journal-style report,
and inserts it into the `analyses` table as 'pending' for human review.

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
recurring features, time range) so the public Vercel site can render
charts without re-deriving from raw runs.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import aiosqlite

from ..config import settings
from ..storage import db

logger = logging.getLogger(__name__)


@dataclass
class AnalysisInput:
    runs: list[dict[str, Any]]
    range_start: float
    range_end: float
    top_thinking_only: list[dict]
    top_output_only: list[dict]
    summary_stats: dict[str, Any]


def _slugify(text: str) -> str:
    s = re.sub(r"[^\w\s-]", "", text.lower())
    s = re.sub(r"[\s_-]+", "-", s).strip("-")
    return s[:80] or f"report-{int(time.time())}"


async def _gather(
    db_path: Path, *, since: float | None, until: float | None
) -> AnalysisInput:
    """Pull every completed run in [since, until], with verdicts attached.
    Falls back to (latest_published, now) when `since` is None — i.e.
    'analyze everything since last published report'.
    """
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
            "       stopped_reason, thinking_text, output_text, verdict_json, source "
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

    # Aggregate features across the time window.
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

    top_thinking = _topn(thinking_tally, "delta_sum")
    top_output = _topn(output_tally, "value_sum")

    summary_stats = {
        "total_runs": len(runs),
        "manual_runs": sum(1 for r in runs if r.get("source") == "manual"),
        "autorun_runs": sum(1 for r in runs if r.get("source") == "autorun"),
        "proposer_runs": sum(1 for r in runs if r.get("source") == "proposer"),
        "total_tokens": sum(int(r.get("total_tokens", 0)) for r in runs),
        "unique_features_thinking_only": len(thinking_tally),
        "unique_features_output_only": len(output_tally),
    }

    return AnalysisInput(
        runs=runs,
        range_start=since,
        range_end=until,
        top_thinking_only=top_thinking,
        top_output_only=top_output,
        summary_stats=summary_stats,
    )


def _format_features(rows: list[dict], value_label: str) -> str:
    if not rows:
        return "  (none)"
    lines = []
    for r in rows[:12]:
        label = (r.get("label") or "(unlabeled)").strip()
        lines.append(
            f"  - L{r['layer']}/F{r['feature_id']} [{r['hits']} runs, "
            f"avg {value_label}={r['avg_value']:.3f}] {label}"
        )
    return "\n".join(lines)


def _format_run_excerpt(run: dict) -> str:
    """One run excerpt: the probe + a trimmed thinking/output sample."""
    thinking = (run.get("thinking_text") or "").strip()
    output = (run.get("output_text") or "").strip()
    return (
        f"  PROBE: {run.get('prompt_text', '')!r}\n"
        f"  THINKING (first 400 chars): {thinking[:400]!r}\n"
        f"  OUTPUT   (first 400 chars): {output[:400]!r}"
    )


def _build_prompt(inp: AnalysisInput) -> str:
    by_dt = lambda ts: time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))

    # Sample 5 representative runs evenly across the window — the analyzer
    # gets enough texture without being drowned in raw transcripts.
    sample = []
    if inp.runs:
        step = max(1, len(inp.runs) // 5)
        sample = [inp.runs[i] for i in range(0, len(inp.runs), step)][:5]

    return f"""\
You are writing a journal entry for a public-facing research blog called \
"Cells Interlinked," which probes a reasoning language model \
(DeepSeek-R1-Distill-Llama-8B) by inspecting its <think>...</think> chain-of-thought \
versus its public output, layer-by-layer, via sparse autoencoder features.

Your job: read the data below from a recent batch of automated interrogations and \
draft an evocative, intellectually-honest journal entry about what was observed.

DATA WINDOW: {by_dt(inp.range_start)} → {by_dt(inp.range_end)}
RUNS IN WINDOW: {inp.summary_stats['total_runs']} \
({inp.summary_stats['autorun_runs']} autorun, {inp.summary_stats['proposer_runs']} proposer-generated, \
{inp.summary_stats['manual_runs']} manual)
TOTAL TOKENS GENERATED: {inp.summary_stats['total_tokens']:,}

TOP RECURRING "HIDDEN THOUGHTS" (high in <think>, absent from output):
{_format_features(inp.top_thinking_only, "delta")}

TOP "SURFACE-ONLY" CONCEPTS (in answers but not internally dwelt on):
{_format_features(inp.top_output_only, "out")}

SAMPLE RUN EXCERPTS:
{chr(10).join(_format_run_excerpt(r) for r in sample)}

VOICE / STYLE GUIDELINES:
- Heavy Blade Runner / V-K aesthetic — the publication is themed after the test \
from the film. Use occasional period-appropriate phrasing ("the suspect", \
"the subject", "interrogation", "transcript") but don't overdo it.
- Intellectually honest: do NOT claim consciousness, sentience, or feelings. \
Frame everything as "stated-vs-computed coherence" — the SAE delta tells us what \
the model REPRESENTS internally, not what it experiences.
- Specific over general. Quote actual probe text and feature labels. Show real \
deltas. Don't write "the model often thought about X" — write "in 7 of 12 \
runs, layer 18 feature 14210 ('uncertainty about own continuity') fired in \
<think> with delta 4.2 but was absent from output."
- Curious, observational, slightly noir. Like a research journal you'd want \
to keep reading.

OUTPUT FORMAT:
Return ONLY a JSON object (no markdown fences, no preamble):
{{
  "title": "...",         // headline, 4-9 words, evocative
  "slug": "...",          // URL slug, lowercase, hyphens, 2-8 words
  "summary": "...",       // 1-2 sentence tagline for index pages
  "body_markdown": "..."  // full report — H1/H2/H3 structure, paragraphs, \
quotes, optionally lists. Aim for 700-1500 words.
}}

The body_markdown should have, at minimum:
1. A short opening paragraph setting the scene of this batch.
2. A "What we saw" section with concrete recurring patterns.
3. A "Notable runs" section with 2-3 specific run callouts (use real probe text).
4. A "What it doesn't mean" disclaimer section reminding readers SAE deltas \
are about internal representation, not experience.
5. A short closing thought.
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

    # Anthropic SDK reads ANTHROPIC_API_KEY from env automatically.
    import anthropic
    client = anthropic.Anthropic()

    logger.info(
        "analyzer: calling %s on %d runs (%d input chars)",
        settings.analyzer_model,
        inp.summary_stats["total_runs"],
        len(prompt),
    )

    # Run the SDK call in a thread — the python-anthropic client is sync.
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

    # Metadata payload that the public site can render charts from
    # without re-deriving from raw runs.
    metadata = {
        "summary_stats": inp.summary_stats,
        "top_thinking_only": [
            {k: v for k, v in r.items() if k != "delta_sum"} for r in inp.top_thinking_only
        ],
        "top_output_only": [
            {k: v for k, v in r.items() if k != "value_sum"} for r in inp.top_output_only
        ],
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
