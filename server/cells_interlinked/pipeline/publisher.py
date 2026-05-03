"""Publish glue: copy a pending analysis into the journal/ subdir,
optionally git-commit-and-push so Vercel auto-deploys.

Called from POST /journal/publish/{id}. Returns a dict describing what
happened so the local UI can confirm + show any git output.

Failure modes:
- Missing journal/ directory  → raises (analysis stays pending)
- Slug collision               → raises (don't overwrite a published report)
- Git push fails               → write succeeds, push step records the
                                  error but does NOT raise. Caller can
                                  push manually later. (Common case: no
                                  network, or the repo has no remote yet.)
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# repo_root/journal/data/reports/{slug}
def _reports_dir() -> Path:
    # server/cells_interlinked/pipeline/publisher.py → repo root is parents[3]
    repo_root = Path(__file__).resolve().parents[3]
    return repo_root / "journal" / "data" / "reports"


def _build_report_json(rec: dict) -> dict[str, Any]:
    """Convert an `analyses` row into the shape the journal/ site reads.

    The journal expects the metadata keys the analyzer wrote into
    `metadata_json`, plus the top-level fields it pulls separately:
    title, summary, slug, published_at, model, range_start/end,
    runs_included.
    """
    metadata_raw = rec.get("metadata_json")
    if isinstance(metadata_raw, str):
        try:
            metadata = json.loads(metadata_raw)
        except json.JSONDecodeError:
            metadata = {}
    else:
        metadata = rec.get("metadata") or {}
    return {
        "slug": rec["slug"],
        "title": rec["title"],
        "summary": rec.get("summary") or "",
        "range_start": rec.get("range_start"),
        "range_end": rec.get("range_end"),
        "runs_included": rec.get("runs_included") or 0,
        "model": rec.get("model") or "",
        "published_at": rec.get("published_at"),  # set after status flip
        "metadata": metadata,
    }


async def publish_analysis(rec: dict) -> dict[str, Any]:
    """Write report files. Returns a dict with status + git output."""
    if not rec.get("slug"):
        raise RuntimeError("analysis has no slug")
    if not rec.get("body_markdown"):
        raise RuntimeError("analysis has empty body_markdown")

    reports_dir = _reports_dir()
    if not reports_dir.parent.parent.exists():
        # journal/ root missing — refuse to silently write outside-tree.
        raise RuntimeError(
            f"journal/ subdir not found at {reports_dir.parent.parent}"
        )

    slug_dir = reports_dir / rec["slug"]
    if slug_dir.exists():
        # Slug collision — protect existing report. The user can rename
        # the slug in SQLite + re-publish if they really want this.
        raise RuntimeError(
            f"slug '{rec['slug']}' already exists at {slug_dir}; "
            f"refusing to overwrite"
        )

    slug_dir.mkdir(parents=True, exist_ok=False)

    # The published_at field will be set by the route handler AFTER this
    # function returns, but the file we write here needs it. Set it to
    # the current time so the report.json carries it; if the route's
    # status flip happens in the same instant it'll be fine.
    import time
    published_at = time.time()
    rec_with_ts = {**rec, "published_at": published_at}
    report_json = _build_report_json(rec_with_ts)

    json_path = slug_dir / "report.json"
    body_path = slug_dir / "body.md"

    json_path.write_text(json.dumps(report_json, indent=2), encoding="utf-8")
    body_path.write_text(rec["body_markdown"], encoding="utf-8")

    logger.info("publisher: wrote %s and %s", json_path, body_path)

    # Best-effort git: add, commit, push. Failure is non-fatal — the UI
    # surfaces the result so the user can push manually if needed.
    git_result = await _git_publish(
        files=[json_path, body_path],
        message=f"journal: publish '{rec['title']}' ({rec['slug']})",
    )

    return {
        "ok": True,
        "slug": rec["slug"],
        "json_path": str(json_path),
        "body_path": str(body_path),
        "git": git_result,
    }


async def _git_publish(files: list[Path], message: str) -> dict[str, Any]:
    repo_root = Path(__file__).resolve().parents[3]

    async def run(*args: str) -> tuple[int, str, str]:
        proc = await asyncio.create_subprocess_exec(
            "git",
            *args,
            cwd=str(repo_root),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out_b, err_b = await proc.communicate()
        return (
            proc.returncode or 0,
            out_b.decode("utf-8", errors="replace"),
            err_b.decode("utf-8", errors="replace"),
        )

    log: list[str] = []

    # 1) Stage just the new files.
    rel_files = [str(p.relative_to(repo_root)) for p in files]
    rc, out, err = await run("add", "--", *rel_files)
    log.append(f"git add → rc={rc} {out}{err}".strip())
    if rc != 0:
        return {"committed": False, "pushed": False, "log": "\n".join(log)}

    # 2) Commit.
    rc, out, err = await run("commit", "-m", message)
    log.append(f"git commit → rc={rc} {out}{err}".strip())
    if rc != 0:
        # If nothing changed (race), still return success on commit but
        # don't try to push the empty thing.
        return {"committed": False, "pushed": False, "log": "\n".join(log)}

    # 3) Push to default remote (best-effort; failure is non-fatal).
    rc, out, err = await run("push")
    log.append(f"git push → rc={rc} {out}{err}".strip())
    pushed = rc == 0

    return {
        "committed": True,
        "pushed": pushed,
        "log": "\n".join(log),
    }
