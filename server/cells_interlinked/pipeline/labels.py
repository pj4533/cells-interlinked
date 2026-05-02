"""Neuronpedia auto-interp label fetcher with persistent SQLite cache.

For Llama-Scope-R1 SAE features applied to DeepSeek-R1-Distill-Llama-8B,
Neuronpedia hosts GPT-4o-mini-generated explanations for every layer 0..31
of the slimpj-openr1 variant. We hit
  GET {api_base}/feature/{model_id}/{layer}-{sae_suffix}/{feature_id}
and pull the first explanation's `description` field.

Cache is keyed by (layer, feature_id) and lives in the same SQLite DB as
the probe records — one row per feature, populated lazily, no expiry. If
the API is unreachable or returns 404, we cache an empty string so we
don't keep retrying.
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
SCHEMA = """
CREATE TABLE IF NOT EXISTS feature_labels (
  layer        INTEGER NOT NULL,
  feature_id   INTEGER NOT NULL,
  label        TEXT NOT NULL,
  fetched_at   REAL NOT NULL,
  PRIMARY KEY (layer, feature_id)
);
"""

_FETCH_TIMEOUT = 5.0   # per-feature HTTP timeout (seconds)
_MAX_CONCURRENT = 16   # parallelism into Neuronpedia
# Use a fairly large connection pool but cap parallelism with a semaphore so
# we don't hammer Neuronpedia or trigger their rate limit.
_semaphore = asyncio.Semaphore(_MAX_CONCURRENT)


async def init_labels_table(db_path: Path) -> None:
    async with aiosqlite.connect(db_path) as db:
        await db.executescript(SCHEMA)
        await db.commit()


def _sae_id(layer: int) -> str:
    return f"{layer}-{settings.neuronpedia_sae_suffix}"


def _feature_url(layer: int, feature_id: int) -> str:
    return (
        f"{settings.neuronpedia_api_base}/feature/"
        f"{settings.neuronpedia_model_id}/{_sae_id(layer)}/{feature_id}"
    )


async def _fetch_one(session: aiohttp.ClientSession, layer: int, feature_id: int) -> str:
    """Fetch a single feature's first explanation description. Returns empty
    string on miss / error so the caller can cache the negative result."""
    url = _feature_url(layer, feature_id)
    async with _semaphore:
        try:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=_FETCH_TIMEOUT)) as resp:
                if resp.status != 200:
                    return ""
                payload = await resp.json()
        except (asyncio.TimeoutError, aiohttp.ClientError):
            return ""

    explanations = payload.get("explanations") or []
    if not explanations:
        return ""
    desc = explanations[0].get("description") or ""
    return desc.strip()


async def get_labels(
    db_path: Path,
    keys: list[tuple[int, int]],
) -> dict[tuple[int, int], str]:
    """Return labels for the requested (layer, feature_id) pairs.

    Reads from the SQLite cache first; fetches misses from Neuronpedia in
    parallel; writes both hits and explicit misses (empty string) back to
    the cache. Returns a dict; missing labels appear as empty strings, never
    KeyError.
    """
    if not keys:
        return {}

    keys = list({k for k in keys})  # dedupe
    out: dict[tuple[int, int], str] = {}
    misses: list[tuple[int, int]] = []

    async with aiosqlite.connect(db_path) as db:
        # Bulk-read existing rows; SQLite has no native tuple-IN, so we iterate.
        # 200-ish keys is small enough that this is fine.
        for layer, fid in keys:
            cur = await db.execute(
                "SELECT label FROM feature_labels WHERE layer = ? AND feature_id = ?",
                (layer, fid),
            )
            row = await cur.fetchone()
            await cur.close()
            if row is None:
                misses.append((layer, fid))
            else:
                out[(layer, fid)] = row[0]

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
            for (layer, fid), label in zip(misses, results):
                out[(layer, fid)] = label
                await db.execute(
                    "INSERT OR REPLACE INTO feature_labels "
                    "(layer, feature_id, label, fetched_at) VALUES (?, ?, ?, ?)",
                    (layer, fid, label, now),
                )
            await db.commit()
        hit_count = sum(1 for r in results if r)
        logger.info("got %d/%d labels (%d empty)", hit_count, len(misses), len(misses) - hit_count)

    return out
