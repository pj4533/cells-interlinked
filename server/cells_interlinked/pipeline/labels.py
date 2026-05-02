"""Neuronpedia auto-interp label fetcher with persistent SQLite cache.

For Llama-Scope-R1 SAE features applied to DeepSeek-R1-Distill-Llama-8B,
Neuronpedia hosts auto-interp explanations for every layer 0..31 of the
slimpj-openr1 variant. The default bulk pass used GPT-4o-mini, but
individual users have triggered fresh labels with stronger explainer
models (Sonnet, Opus, Haiku, etc.) — those land in the same
`explanations[]` array on the feature page, attributed to the user who
generated them and visible to everyone.

We pick the BEST available explanation per feature by ranking the
explainer model:
  Claude Opus / Sonnet / Haiku 4.5  →  Claude 3.7 Sonnet  →  Claude 3.5 Sonnet
  →  GPT-4.1 / o3 / o4-mini         →  GPT-4o (full)      →  GPT-4o-mini

Cache stores both the label text AND the explainer model name (so the UI
can display a small badge showing which model produced it).
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import aiohttp
import aiosqlite

from ..config import settings

logger = logging.getLogger(__name__)

# Schema for the labels cache table; lives alongside the `probes` table.
# `model` column was added when we started picking among multiple
# explainers; older rows without it default to "" via COALESCE.
SCHEMA = """
CREATE TABLE IF NOT EXISTS feature_labels (
  layer        INTEGER NOT NULL,
  feature_id   INTEGER NOT NULL,
  label        TEXT NOT NULL,
  model        TEXT NOT NULL DEFAULT '',
  fetched_at   REAL NOT NULL,
  PRIMARY KEY (layer, feature_id)
);
"""

_FETCH_TIMEOUT = 5.0   # per-feature HTTP timeout (seconds)
_MAX_CONCURRENT = 16   # parallelism into Neuronpedia
_semaphore = asyncio.Semaphore(_MAX_CONCURRENT)


# Quality ranking for picking among multiple explainer models on the same
# feature. Lower number = better. Anything not listed is ranked last (999).
# Substring match against the lowercase model name returned by Neuronpedia
# (e.g. "claude-3-5-sonnet-20240620", "gpt-4o-mini", "gemini-2.0-flash").
_EXPLAINER_RANK: list[tuple[str, int]] = [
    # Claude Opus (top tier)
    ("claude-opus-4", 1),
    ("claude-opus-3", 5),
    # Claude Sonnet
    ("claude-sonnet-4", 10),
    ("claude-3-7-sonnet", 11),
    ("claude-3-5-sonnet", 12),
    ("claude-3-sonnet", 13),
    # Claude Haiku
    ("claude-haiku-4", 20),
    ("claude-3-5-haiku", 21),
    ("claude-3-haiku", 22),
    # OpenAI flagships
    ("gpt-4.1", 30),
    ("gpt-4-turbo", 31),
    ("o4-mini", 32),
    ("o3", 33),
    # Google Gemini Pro / Flash. Neuronpedia's recent re-bulk pass on
    # Llama-Scope-R1 used gemini-2.0-flash, and the labels are noticeably
    # better than GPT-4o-mini's bulk pass — but still less specific than
    # Claude Sonnet on hard features.
    ("gemini-2.5-pro", 35),
    ("gemini-2.0-pro", 36),
    ("gemini-2.5-flash", 38),
    ("gemini-2.0-flash", 40),
    ("gemini-1.5-pro", 41),
    ("gemini-1.5-flash", 42),
    # GPT-4o
    ("gpt-4o-mini", 60),
    ("gpt-4o", 49),  # full GPT-4o better than mini
]


def _rank_explainer(model_name: str) -> int:
    name = (model_name or "").lower()
    for substr, rank in _EXPLAINER_RANK:
        if substr in name:
            return rank
    return 999


async def init_labels_table(db_path: Path) -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.executescript(SCHEMA)
        # Migration: add `model` column to existing tables that predate it.
        cur = await db.execute("PRAGMA table_info(feature_labels)")
        cols = {row[1] for row in await cur.fetchall()}
        await cur.close()
        if "model" not in cols:
            await db.execute(
                "ALTER TABLE feature_labels ADD COLUMN model TEXT NOT NULL DEFAULT ''"
            )
        await db.commit()


def _sae_id(layer: int) -> str:
    return f"{layer}-{settings.neuronpedia_sae_suffix}"


def _feature_url(layer: int, feature_id: int) -> str:
    return (
        f"{settings.neuronpedia_api_base}/feature/"
        f"{settings.neuronpedia_model_id}/{_sae_id(layer)}/{feature_id}"
    )


async def _fetch_one(
    session: aiohttp.ClientSession, layer: int, feature_id: int
) -> tuple[str, str]:
    """Fetch a single feature; return (label, explainer_model_name).
    Both empty on miss/error so the caller can cache the negative result.
    """
    url = _feature_url(layer, feature_id)
    async with _semaphore:
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=_FETCH_TIMEOUT)) as resp:
                if resp.status != 200:
                    return ("", "")
                payload = await resp.json()
        except (asyncio.TimeoutError, aiohttp.ClientError):
            return ("", "")

    explanations = payload.get("explanations") or []
    if not explanations:
        return ("", "")

    # Pick the best by explainer rank.
    best = min(
        explanations,
        key=lambda e: _rank_explainer(e.get("explanationModelName", "")),
    )
    desc = (best.get("description") or "").strip()
    model = best.get("explanationModelName") or ""
    return (desc, model)


async def get_labels(
    db_path: Path,
    keys: list[tuple[int, int]],
) -> dict[tuple[int, int], dict[str, str]]:
    """Return labels for the requested (layer, feature_id) pairs.

    Each value is a dict {"label": str, "model": str}. Missing labels appear
    as {"label": "", "model": ""}, never KeyError.
    """
    if not keys:
        return {}

    keys = list({k for k in keys})
    out: dict[tuple[int, int], dict[str, str]] = {}
    misses: list[tuple[int, int]] = []

    async with aiosqlite.connect(db_path) as db:
        for layer, fid in keys:
            cur = await db.execute(
                "SELECT label, COALESCE(model, '') FROM feature_labels "
                "WHERE layer = ? AND feature_id = ?",
                (layer, fid),
            )
            row = await cur.fetchone()
            await cur.close()
            if row is None:
                misses.append((layer, fid))
            else:
                out[(layer, fid)] = {"label": row[0], "model": row[1]}

    if misses:
        logger.info("fetching %d feature labels from Neuronpedia", len(misses))
        connector = aiohttp.TCPConnector(limit=_MAX_CONCURRENT * 2)
        async with aiohttp.ClientSession(connector=connector) as session:
            results = await asyncio.gather(
                *[_fetch_one(session, l, f) for (l, f) in misses],
                return_exceptions=False,
            )
        now = asyncio.get_event_loop().time()
        async with aiosqlite.connect(db_path) as db:
            for (layer, fid), (label, model) in zip(misses, results):
                out[(layer, fid)] = {"label": label, "model": model}
                await db.execute(
                    "INSERT OR REPLACE INTO feature_labels "
                    "(layer, feature_id, label, model, fetched_at) VALUES (?, ?, ?, ?, ?)",
                    (layer, fid, label, model, now),
                )
            await db.commit()
        hit_count = sum(1 for label, _ in results if label)
        # Tally explainer models actually used so we can see Sonnet coverage.
        from collections import Counter
        counts = Counter(m or "(none)" for _, m in results)
        logger.info(
            "got %d/%d labels — explainer breakdown: %s",
            hit_count, len(misses),
            ", ".join(f"{m}:{n}" for m, n in counts.most_common()),
        )

    return out
