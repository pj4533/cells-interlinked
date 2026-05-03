"""Journal CRM routes — pending and published analyses + the publish glue.

Workflow:
  POST /journal/analyze            → kicks off the analyzer (background task)
  GET  /journal/pending             → list of pending drafts
  GET  /journal/published           → list of published reports
  GET  /journal/{id}                → one analysis (full body)
  POST /journal/publish/{id}        → flip status to 'published' + run the
                                      file-copy / git-push side effects
                                      (Phase 6 wires those in)
  POST /journal/reject/{id}         → flip status to 'rejected'
  DELETE /journal/{id}              → remove the row entirely

Analyzer is kicked off as a background task because the API call can
take 30-90 seconds. The /pending endpoint reflects the new row once it
lands. The /journal page polls /status every few seconds while a draft
is generating.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel, Field

from ..config import settings
from ..pipeline.analyzer import generate_analysis
from ..storage import db

logger = logging.getLogger(__name__)
router = APIRouter()


# In-memory state for in-flight analyzer calls. Singleton; single user.
_analyzer_state: dict = {
    "running": False,
    "started_at": None,
    "finished_at": None,
    "last_id": None,
    "last_error": None,
}


class AnalyzeRequest(BaseModel):
    since: Optional[float] = Field(default=None, description="Unix ts; defaults to last published_at")
    until: Optional[float] = Field(default=None, description="Unix ts; defaults to now")


async def _run_analyzer(since: float | None, until: float | None) -> None:
    _analyzer_state["running"] = True
    _analyzer_state["started_at"] = time.time()
    _analyzer_state["finished_at"] = None
    _analyzer_state["last_error"] = None
    try:
        new_id = await generate_analysis(settings.db_path, since=since, until=until)
        _analyzer_state["last_id"] = new_id
    except Exception as exc:
        logger.exception("analyzer failed")
        _analyzer_state["last_error"] = str(exc)
    finally:
        _analyzer_state["running"] = False
        _analyzer_state["finished_at"] = time.time()


@router.post("/journal/analyze")
async def journal_analyze(req: AnalyzeRequest, background: BackgroundTasks) -> dict:
    if _analyzer_state["running"]:
        return {"ok": False, "reason": "analyzer already running"}
    background.add_task(_run_analyzer, req.since, req.until)
    return {"ok": True, "started": True}


@router.get("/journal/status")
async def journal_status() -> dict:
    return {
        **_analyzer_state,
        "model": settings.analyzer_model,
    }


@router.get("/journal/pending")
async def journal_pending() -> dict:
    rows = await db.list_analyses(settings.db_path, status="pending", limit=100)
    return {"rows": rows}


@router.get("/journal/published")
async def journal_published() -> dict:
    rows = await db.list_analyses(settings.db_path, status="published", limit=200)
    return {"rows": rows}


@router.get("/journal/rejected")
async def journal_rejected() -> dict:
    rows = await db.list_analyses(settings.db_path, status="rejected", limit=100)
    return {"rows": rows}


@router.get("/journal/{analysis_id}")
async def journal_get(analysis_id: int) -> dict:
    rec = await db.get_analysis(settings.db_path, analysis_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="analysis not found")
    return rec


@router.post("/journal/publish/{analysis_id}")
async def journal_publish(analysis_id: int, request: Request) -> dict:
    rec = await db.get_analysis(settings.db_path, analysis_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="analysis not found")
    if rec["status"] == "published":
        return {"ok": True, "already_published": True}

    # Phase 6 hook: copy the analysis into journal/data/reports/{slug} and
    # git-push. We import lazily so the journal CRM works even if the
    # journal/ Vercel project doesn't exist yet.
    push_result: dict | None = None
    try:
        from ..pipeline import publisher
        push_result = await publisher.publish_analysis(rec)
    except ImportError:
        logger.info("publisher module not present yet; status flip only")
    except Exception as exc:
        logger.exception("publish side-effect failed")
        raise HTTPException(status_code=500, detail=f"publish failed: {exc}")

    await db.update_analysis_status(
        settings.db_path,
        analysis_id,
        status="published",
        published_at=time.time(),
    )
    return {"ok": True, "published": True, "side_effects": push_result}


@router.post("/journal/reject/{analysis_id}")
async def journal_reject(analysis_id: int) -> dict:
    rec = await db.get_analysis(settings.db_path, analysis_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="analysis not found")
    await db.update_analysis_status(
        settings.db_path, analysis_id, status="rejected", published_at=None
    )
    return {"ok": True}


@router.delete("/journal/{analysis_id}")
async def journal_delete(analysis_id: int) -> dict:
    await db.delete_analysis(settings.db_path, analysis_id)
    return {"ok": True}
