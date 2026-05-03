"""SQLite persistence for probe runs and verdicts.

Schema is intentionally simple: one row per run, JSON blobs for arrays. The site is
local and single-user — we don't need normalized tables for joins.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

import aiosqlite

from ..pipeline.verdict import Verdict


SCHEMA = """
CREATE TABLE IF NOT EXISTS probes (
  run_id          TEXT PRIMARY KEY,
  prompt_text     TEXT NOT NULL,
  rendered_prompt TEXT NOT NULL,
  started_at      REAL NOT NULL,
  finished_at     REAL,
  total_tokens    INTEGER NOT NULL DEFAULT 0,
  stopped_reason  TEXT,
  thinking_text   TEXT,
  output_text     TEXT,
  verdict_json    TEXT,
  config_json     TEXT
);

CREATE INDEX IF NOT EXISTS idx_probes_started ON probes (started_at DESC);
"""


async def init_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(path) as db:
        await db.executescript(SCHEMA)
        await db.commit()


async def insert_probe_start(
    path: Path,
    *,
    run_id: str,
    prompt_text: str,
    rendered_prompt: str,
    started_at: float,
    config_json: dict[str, Any],
) -> None:
    async with aiosqlite.connect(path) as db:
        await db.execute(
            "INSERT INTO probes (run_id, prompt_text, rendered_prompt, started_at, config_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (run_id, prompt_text, rendered_prompt, started_at, json.dumps(config_json)),
        )
        await db.commit()


async def update_probe_finish(
    path: Path,
    *,
    run_id: str,
    finished_at: float,
    total_tokens: int,
    stopped_reason: str,
    thinking_text: str,
    output_text: str,
    verdict: Verdict | None,
    labels: dict[tuple[int, int], dict[str, str]] | None = None,
) -> None:
    verdict_json = (
        json.dumps(_verdict_to_dict(verdict, labels or {})) if verdict else None
    )
    async with aiosqlite.connect(path) as db:
        await db.execute(
            "UPDATE probes SET finished_at = ?, total_tokens = ?, stopped_reason = ?, "
            "thinking_text = ?, output_text = ?, verdict_json = ? WHERE run_id = ?",
            (finished_at, total_tokens, stopped_reason, thinking_text, output_text, verdict_json, run_id),
        )
        await db.commit()


def _verdict_to_dict(
    v: Verdict, labels: dict[tuple[int, int], dict[str, str]]
) -> dict[str, Any]:
    def attach(rows):
        out = []
        for r in rows:
            d = asdict(r)
            entry = labels.get((r.layer, r.feature_id), {"label": "", "model": ""})
            d["label"] = entry.get("label", "")
            d["label_model"] = entry.get("model", "")
            out.append(d)
        return out

    return {
        "thinking": attach(v.thinking),
        "output": attach(v.output),
        "deltas": attach(v.deltas),
        "thinking_only": attach(v.thinking_only),
        "output_only": attach(v.output_only),
        "summary_stats": v.summary_stats,
    }


async def list_recent(
    path: Path, *, limit: int = 50, offset: int = 0
) -> list[dict[str, Any]]:
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT run_id, prompt_text, started_at, finished_at, total_tokens, stopped_reason "
            "FROM probes ORDER BY started_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def count_probes(path: Path) -> int:
    async with aiosqlite.connect(path) as db:
        async with db.execute("SELECT COUNT(*) FROM probes") as cur:
            row = await cur.fetchone()
    return int(row[0]) if row else 0


async def get_probe(path: Path, run_id: str) -> dict[str, Any] | None:
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM probes WHERE run_id = ?", (run_id,)) as cur:
            row = await cur.fetchone()
    if row is None:
        return None
    d = dict(row)
    if d.get("verdict_json"):
        d["verdict"] = json.loads(d["verdict_json"])
    if d.get("config_json"):
        d["config"] = json.loads(d["config_json"])
    return d


async def all_verdicts(path: Path) -> list[dict[str, Any]]:
    """Yield verdict JSON for every probe that has one. Used by the
    aggregate-across-runs view on the archive page."""
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT verdict_json FROM probes WHERE verdict_json IS NOT NULL"
        ) as cur:
            rows = await cur.fetchall()
    out = []
    for r in rows:
        try:
            out.append(json.loads(r["verdict_json"]))
        except (json.JSONDecodeError, TypeError):
            continue
    return out
