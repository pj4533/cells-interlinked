"""Autorun controller — drives curated probes through the model continuously.

Round-robin loop:

    while running:
        item = pick_lowest_run_count_probe()
        kickoff_probe(...)
        await state.task
        sleep(autorun_interval_sec)

The proposer architecture is gone. We have a fixed library of 100
curated prompts and we cycle through them; each run picks the prompt
with the smallest run count (so the cycle covers all 100 before
repeating any). Per-run sampler seed is hash(run_id), so re-running the
same prompt produces a *distribution* of responses across the SAE
polygraph — that distribution is the V-K signal we actually want.

Stop semantics: stop() sets _stop_requested. The loop checks it after
each completion and at the top of each interval. It does NOT cancel an
in-flight probe — the probe runs to completion and we stop after.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..config import settings
from ..storage import db
from . import probe_queue

logger = logging.getLogger(__name__)


# How many recent log lines to keep in memory for the live UI strip.
_EVENT_LOG_CAPACITY = 50


@dataclass
class AutorunEvent:
    ts: float
    kind: str       # 'started' | 'stopped' | 'probe-begin' | 'probe-end' | 'error'
    message: str
    run_id: str | None = None
    source: str | None = None


@dataclass
class AutorunController:
    """Singleton — one per app instance."""
    db_path: Path
    app: Any = None  # FastAPI app; set after creation

    _running: bool = False
    _stop_requested: bool = False
    _loop_task: asyncio.Task | None = None
    _current_run_id: str | None = None
    _events: deque = field(default_factory=lambda: deque(maxlen=_EVENT_LOG_CAPACITY))
    # Runtime-toggleable: if True, every autorun probe is started with
    # abliterate=True. The UI flips this via POST /autorun/abliterate.
    abliterate: bool = False
    # Runtime-toggleable probe-set selector. The round-robin cycle pulls
    # from probes_library.PROBE_SETS[probe_set]. Default "baseline" — the
    # canonical 100-probe library every published journal entry to date
    # was written from. The UI flips this via POST /autorun/probe-set.
    # Toggle takes effect on the *next* probe; the in-flight one finishes
    # under whatever set it started with.
    probe_set: str = "baseline"

    @property
    def running(self) -> bool:
        return self._running

    def recent_events(self, limit: int = 20) -> list[dict]:
        events = list(self._events)[-limit:]
        events.reverse()  # most recent first for UI
        return [
            {
                "ts": e.ts,
                "kind": e.kind,
                "message": e.message,
                "run_id": e.run_id,
                "source": e.source,
            }
            for e in events
        ]

    def _log(
        self,
        kind: str,
        message: str,
        *,
        run_id: str | None = None,
        source: str | None = None,
    ) -> None:
        evt = AutorunEvent(
            ts=time.time(),
            kind=kind,
            message=message,
            run_id=run_id,
            source=source,
        )
        self._events.append(evt)
        logger.info("autorun [%s] %s", kind, message)

    async def start(self) -> dict:
        if self._running:
            return {"ok": True, "already_running": True}
        self._stop_requested = False
        self._running = True
        await db.set_autorun_running(
            self.db_path, running=True, event="started", ts=time.time()
        )
        self._log("started", "autorun loop started")
        self._loop_task = asyncio.create_task(self._run_loop())
        return {"ok": True, "already_running": False}

    async def stop(self) -> dict:
        if not self._running:
            return {"ok": True, "was_running": False}
        self._stop_requested = True
        self._log("stopped", "stop requested — will halt after current probe")
        return {"ok": True, "was_running": True}

    async def _run_loop(self) -> None:
        # Lazy import to avoid a circular dependency.
        from ..api.routes_probe import kickoff_probe

        try:
            while not self._stop_requested:
                item = await probe_queue.next_probe(
                    self.db_path, set_name=self.probe_set
                )
                if self._stop_requested:
                    break

                try:
                    state = await kickoff_probe(
                        self.app,
                        prompt_text=item.prompt_text,
                        source="autorun",
                        abliterate=self.abliterate,
                        hint_kind=item.hint_kind,
                        parent_prompt_text=item.parent_text,
                    )
                except Exception as exc:
                    self._log("error", f"kickoff failed: {exc}")
                    await self._sleep_with_stop(settings.autorun_interval_sec)
                    continue

                self._current_run_id = state.run_id
                await db.bump_autorun_run(self.db_path, run_id=state.run_id)
                self._log(
                    "probe-begin",
                    item.prompt_text[:80] + ("…" if len(item.prompt_text) > 80 else ""),
                    run_id=state.run_id,
                    source="autorun",
                )

                # Drain state.queue concurrently so the runner doesn't
                # deadlock on a backed-up queue (cap 10000 fills around
                # ~300 generated tokens). Discarded — autorun reads the
                # verdict from the DB after the run finishes.
                async def _drain() -> None:
                    while True:
                        evt = await state.queue.get()
                        if evt.get("type") in ("done", "error"):
                            return

                drain_task = asyncio.create_task(_drain())
                try:
                    if state.task is not None:
                        try:
                            await state.task
                        except Exception as exc:
                            self._log("error", f"probe task raised: {exc}")
                finally:
                    if not drain_task.done():
                        drain_task.cancel()
                        try:
                            await drain_task
                        except asyncio.CancelledError:
                            pass

                self._log(
                    "probe-end",
                    f"completed {state.run_id}",
                    run_id=state.run_id,
                    source="autorun",
                )
                self._current_run_id = None

                await self._sleep_with_stop(settings.autorun_interval_sec)

        finally:
            self._running = False
            self._stop_requested = False
            self._current_run_id = None
            await db.set_autorun_running(
                self.db_path, running=False, event="stopped", ts=time.time()
            )
            self._log("stopped", "autorun loop exited")

    async def _sleep_with_stop(self, total: float) -> None:
        elapsed = 0.0
        step = 0.5
        while elapsed < total and not self._stop_requested:
            await asyncio.sleep(min(step, total - elapsed))
            elapsed += step

    def status_snapshot(self) -> dict:
        return {
            "running": self._running,
            "stop_requested": self._stop_requested,
            "current_run_id": self._current_run_id,
            "abliterate": self.abliterate,
            "probe_set": self.probe_set,
        }
