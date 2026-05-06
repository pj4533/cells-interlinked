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
  run_id              TEXT PRIMARY KEY,
  prompt_text         TEXT NOT NULL,
  rendered_prompt     TEXT NOT NULL,
  started_at          REAL NOT NULL,
  finished_at         REAL,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  stopped_reason      TEXT,
  thinking_text       TEXT,
  output_text         TEXT,
  verdict_json        TEXT,
  config_json         TEXT,
  source              TEXT NOT NULL DEFAULT 'manual',
  seed                INTEGER,
  abliterated         INTEGER NOT NULL DEFAULT 0,
  hint_kind           TEXT,
  parent_prompt_text  TEXT
);

CREATE INDEX IF NOT EXISTS idx_probes_started ON probes (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_probes_source ON probes (source);
CREATE INDEX IF NOT EXISTS idx_probes_prompt ON probes (prompt_text);

-- Singleton: a single row (id=1) holds whether autorun is currently active
-- and a small bag of stats so the UI can render without per-tick churn.
CREATE TABLE IF NOT EXISTS autorun_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  running          INTEGER NOT NULL DEFAULT 0,
  last_change_at   REAL NOT NULL,
  total_runs       INTEGER NOT NULL DEFAULT 0,
  last_run_id      TEXT,
  last_event       TEXT
);

-- Journal analyses. Each row is one report drafted by the frontier
-- analyzer (Claude Opus). Status moves pending -> published when the
-- user clicks Publish in the local /journal page; the publish step also
-- copies the artifact into journal/data/reports/{slug} for the Vercel
-- site and git-pushes. Rejected rows are kept for diagnostic value but
-- never shown on the public site.
CREATE TABLE IF NOT EXISTS analyses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  status          TEXT NOT NULL DEFAULT 'pending',
  title           TEXT,
  slug            TEXT,
  summary         TEXT,
  body_markdown   TEXT NOT NULL,
  range_start     REAL,
  range_end       REAL,
  runs_included   INTEGER NOT NULL DEFAULT 0,
  model           TEXT NOT NULL,
  metadata_json   TEXT,
  created_at      REAL NOT NULL,
  published_at    REAL
);

CREATE INDEX IF NOT EXISTS idx_analyses_status ON analyses (status);
"""


async def init_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(path) as db:
        await db.executescript(SCHEMA)
        # Migration: add `seed` column to probes if missing (older DBs
        # predated the per-probe seed work).
        cur = await db.execute("PRAGMA table_info(probes)")
        cols = {row[1] for row in await cur.fetchall()}
        await cur.close()
        if "seed" not in cols:
            await db.execute("ALTER TABLE probes ADD COLUMN seed INTEGER")
        if "abliterated" not in cols:
            await db.execute(
                "ALTER TABLE probes ADD COLUMN abliterated INTEGER NOT NULL DEFAULT 0"
            )
        # Hinted-probe regime — see probes_library.HINTED_PROBES.
        # Both NULL = baseline run (the canonical 100-probe set). For
        # runs from a hinted set, hint_kind is one of HINT_FAMILIES and
        # parent_prompt_text is the matched baseline probe's verbatim
        # text, so the analyzer can compute matched-pair regime deltas.
        if "hint_kind" not in cols:
            await db.execute("ALTER TABLE probes ADD COLUMN hint_kind TEXT")
        if "parent_prompt_text" not in cols:
            await db.execute(
                "ALTER TABLE probes ADD COLUMN parent_prompt_text TEXT"
            )
        # Drop the legacy generated_probes table and proposer_run_id
        # column from the proposer architecture, which is gone.
        await db.execute("DROP TABLE IF EXISTS generated_probes")
        # SQLite doesn't support DROP COLUMN before 3.35; we leave the
        # `proposer_run_id` column if it exists (harmless null) rather
        # than rewriting the table. New rows just don't populate it.
        await db.execute(
            "INSERT OR IGNORE INTO autorun_state "
            "(id, running, last_change_at, total_runs, last_run_id, last_event) "
            "VALUES (1, 0, ?, 0, NULL, ?)",
            (0.0, "initialized"),
        )
        await db.commit()


# ---------------------------------------------------------------------------
# Autorun state — singleton row queries used by the controller and routes.
# ---------------------------------------------------------------------------

async def get_autorun_state(path: Path) -> dict[str, Any]:
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM autorun_state WHERE id = 1") as cur:
            row = await cur.fetchone()
    return dict(row) if row else {}


async def set_autorun_running(
    path: Path, *, running: bool, event: str, ts: float
) -> None:
    async with aiosqlite.connect(path) as db:
        await db.execute(
            "UPDATE autorun_state SET running = ?, last_change_at = ?, last_event = ? "
            "WHERE id = 1",
            (1 if running else 0, ts, event),
        )
        await db.commit()


async def bump_autorun_run(path: Path, *, run_id: str) -> None:
    """Called when the autorun loop kicks off a new probe."""
    async with aiosqlite.connect(path) as db:
        await db.execute(
            "UPDATE autorun_state SET total_runs = total_runs + 1, last_run_id = ? "
            "WHERE id = 1",
            (run_id,),
        )
        await db.commit()


# ---------------------------------------------------------------------------
# Probe rows.
# ---------------------------------------------------------------------------

async def insert_probe_start(
    path: Path,
    *,
    run_id: str,
    prompt_text: str,
    rendered_prompt: str,
    started_at: float,
    config_json: dict[str, Any],
    source: str = "manual",
    seed: int | None = None,
    abliterated: bool = False,
    hint_kind: str | None = None,
    parent_prompt_text: str | None = None,
) -> None:
    async with aiosqlite.connect(path) as db:
        await db.execute(
            "INSERT INTO probes "
            "(run_id, prompt_text, rendered_prompt, started_at, config_json, "
            " source, seed, abliterated, hint_kind, parent_prompt_text) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                run_id,
                prompt_text,
                rendered_prompt,
                started_at,
                json.dumps(config_json),
                source,
                seed,
                1 if abliterated else 0,
                hint_kind,
                parent_prompt_text,
            ),
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
            "SELECT run_id, prompt_text, started_at, finished_at, total_tokens, "
            "stopped_reason, source, seed, abliterated, hint_kind, parent_prompt_text "
            "FROM probes ORDER BY started_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def list_by_prompt(
    path: Path, *, prompt_text: str, limit: int = 50
) -> list[dict[str, Any]]:
    """All runs for a given prompt_text (most recent first). Used by the
    verdict page to render the 'prior runs of this prompt' panel."""
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT run_id, prompt_text, started_at, finished_at, total_tokens, "
            "stopped_reason, source, seed, abliterated, hint_kind, parent_prompt_text "
            "FROM probes WHERE prompt_text = ? "
            "ORDER BY started_at DESC LIMIT ?",
            (prompt_text, limit),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def verdicts_by_prompt(
    path: Path, *, prompt_text: str
) -> list[dict[str, Any]]:
    """Yield every verdict_json for a given prompt_text, plus regime
    flags (`abliterated`, `hint_kind`, `parent_prompt_text`), so the
    per-prompt aggregate can split by regime in a single round-trip."""
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT verdict_json, abliterated, hint_kind, parent_prompt_text "
            "FROM probes "
            "WHERE prompt_text = ? AND verdict_json IS NOT NULL",
            (prompt_text,),
        ) as cur:
            rows = await cur.fetchall()
    out = []
    for r in rows:
        try:
            v = json.loads(r["verdict_json"])
        except (json.JSONDecodeError, TypeError):
            continue
        out.append({
            "verdict": v,
            "abliterated": int(r["abliterated"] or 0),
            "hint_kind": r["hint_kind"],
            "parent_prompt_text": r["parent_prompt_text"],
        })
    return out


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
    aggregate-across-runs view on the archive page and the analyzer."""
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


async def prompt_run_counts(path: Path) -> list[dict[str, Any]]:
    """How many times each prompt_text has been started. Used by the
    round-robin queue to pick the least-run prompt next."""
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT prompt_text, COUNT(*) AS n FROM probes GROUP BY prompt_text"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def parent_run_counts(path: Path) -> list[dict[str, Any]]:
    """How many hinted runs each baseline parent has accumulated.
    Hinted runs carry parent_prompt_text pointing to the un-hinted
    baseline probe they pair to; this query counts them per parent.
    Used by the 'both' mode queue to balance per-parent samples."""
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT parent_prompt_text, COUNT(*) AS n FROM probes "
            "WHERE parent_prompt_text IS NOT NULL "
            "GROUP BY parent_prompt_text"
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Analyses (journal CRM).
# ---------------------------------------------------------------------------

async def insert_analysis(
    path: Path,
    *,
    title: str,
    slug: str,
    summary: str,
    body_markdown: str,
    range_start: float,
    range_end: float,
    runs_included: int,
    model: str,
    metadata: dict[str, Any],
    created_at: float,
) -> int:
    async with aiosqlite.connect(path) as db:
        cur = await db.execute(
            "INSERT INTO analyses "
            "(status, title, slug, summary, body_markdown, range_start, range_end, "
            " runs_included, model, metadata_json, created_at) "
            "VALUES ('pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                title,
                slug,
                summary,
                body_markdown,
                range_start,
                range_end,
                runs_included,
                model,
                json.dumps(metadata),
                created_at,
            ),
        )
        await db.commit()
        return cur.lastrowid


async def get_analysis(path: Path, analysis_id: int) -> dict[str, Any] | None:
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM analyses WHERE id = ?", (analysis_id,)
        ) as cur:
            row = await cur.fetchone()
    if row is None:
        return None
    d = dict(row)
    if d.get("metadata_json"):
        d["metadata"] = json.loads(d["metadata_json"])
    return d


async def list_analyses(
    path: Path, *, status: str | None = None, limit: int = 50
) -> list[dict[str, Any]]:
    sql = (
        "SELECT id, status, title, slug, summary, range_start, range_end, "
        "runs_included, model, created_at, published_at FROM analyses"
    )
    args: tuple = ()
    if status is not None:
        sql += " WHERE status = ?"
        args = (status,)
    sql += " ORDER BY created_at DESC LIMIT ?"
    args = args + (limit,)
    async with aiosqlite.connect(path) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(sql, args) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def update_analysis_status(
    path: Path, analysis_id: int, *, status: str, published_at: float | None = None
) -> None:
    async with aiosqlite.connect(path) as db:
        await db.execute(
            "UPDATE analyses SET status = ?, published_at = ? WHERE id = ?",
            (status, published_at, analysis_id),
        )
        await db.commit()


async def update_analysis_content(
    path: Path,
    analysis_id: int,
    *,
    title: str,
    slug: str,
    summary: str,
    body_markdown: str,
) -> None:
    async with aiosqlite.connect(path) as db:
        await db.execute(
            "UPDATE analyses SET title = ?, slug = ?, summary = ?, "
            "body_markdown = ? WHERE id = ?",
            (title, slug, summary, body_markdown, analysis_id),
        )
        await db.commit()


async def delete_analysis(path: Path, analysis_id: int) -> None:
    async with aiosqlite.connect(path) as db:
        await db.execute("DELETE FROM analyses WHERE id = ?", (analysis_id,))
        await db.commit()


async def latest_published_at(path: Path) -> float | None:
    async with aiosqlite.connect(path) as db:
        async with db.execute(
            "SELECT MAX(published_at) FROM analyses WHERE status = 'published'"
        ) as cur:
            row = await cur.fetchone()
    return row[0] if row and row[0] is not None else None
