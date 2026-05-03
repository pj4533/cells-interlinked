"""Autorun controller — drives probes through the model continuously.

A single asyncio task runs the loop:

    while running:
        item = next_probe(db_path)
        if item is None:
            request_proposer()        # background subprocess (Phase 3)
            await sleep(idle_backoff) # then re-check
            continue
        state = kickoff_probe(...)    # via the same path POST /probe uses
        commit_used(item, run_id)
        await state.task              # wait for completion
        await sleep(interval)         # gap so polygraph still feels live

The controller is a singleton attached to `app.state.autorun`. All state
that survives a server restart lives in the SQLite `autorun_state` row;
in-process state (event log, current run id, proposer status) is held on
the controller for the live UI.

Stop semantics: `stop()` sets `_stop_requested`. The loop checks it after
each completion and at the top of each idle backoff. It does NOT cancel
an in-flight probe — that probe runs to completion and we stop after.
This avoids leaving the SQLite row in a half-finished state and keeps
the model lock release deterministic.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ..config import settings
from ..storage import db
from . import probe_queue

if TYPE_CHECKING:
    from fastapi import FastAPI

logger = logging.getLogger(__name__)

# How many recent log lines to keep in memory for the live UI strip.
_EVENT_LOG_CAPACITY = 50

# When the queue is empty and the proposer hasn't been triggered yet,
# wait this long before re-checking. Short so the UI feels responsive
# once the proposer drops new probes; long enough not to spin.
_IDLE_BACKOFF_SEC = 8.0

# When the proposer is actively running, poll for completion at this
# interval. Proposer runs take a few minutes (Qwen3-14B load + generate),
# so polling every 10s is plenty.
_PROPOSER_POLL_SEC = 10.0


@dataclass
class AutorunEvent:
    ts: float
    kind: str       # 'started' | 'stopped' | 'probe-begin' | 'probe-end' | 'queue-empty' | 'proposer' | 'error'
    message: str
    run_id: str | None = None
    source: str | None = None


@dataclass
class ProposerStatus:
    state: str = "idle"  # 'idle' | 'running' | 'failed'
    started_at: float | None = None
    finished_at: float | None = None
    last_count: int = 0           # how many probes the last run produced
    last_error: str | None = None


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
    _proposer: ProposerStatus = field(default_factory=ProposerStatus)
    _proposer_task: asyncio.Task | None = None

    @property
    def running(self) -> bool:
        return self._running

    @property
    def proposer_status(self) -> ProposerStatus:
        return self._proposer

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
        # Don't await the loop here; UI returns immediately. The loop will
        # observe _stop_requested at its next checkpoint.
        return {"ok": True, "was_running": True}

    async def _run_loop(self) -> None:
        # Lazy import to avoid a circular dependency: autorun.py is imported
        # by app.py during lifespan; routes_probe.py imports `from ..pipeline
        # ...` which would loop back through here if the import happened at
        # module load time.
        from ..api.routes_probe import kickoff_probe

        try:
            while not self._stop_requested:
                item = await probe_queue.next_probe(self.db_path)

                if item is None:
                    self._log("queue-empty", "no probes in queue — requesting proposer")
                    await self._maybe_kick_proposer()
                    # Wait, then re-check.
                    await self._sleep_with_stop(_IDLE_BACKOFF_SEC)
                    continue

                # Drive the probe through the same path manual probes use.
                # NOTE: don't hold registry.lock here — `_execute_probe`
                # acquires it itself, and asyncio.Lock is not reentrant,
                # so wrapping the kickoff would deadlock the await below.
                # Serialization is fine: the autorun loop only kicks off
                # one probe at a time and awaits it before continuing,
                # and any concurrent manual probe naturally queues on
                # the same lock inside _execute_probe.
                if self._stop_requested:
                    break
                try:
                    state = await kickoff_probe(
                        self.app,
                        prompt_text=item.prompt_text,
                        source=item.source,
                        proposer_run_id=item.proposer_run_id,
                    )
                except Exception as exc:
                    self._log("error", f"kickoff failed: {exc}")
                    await self._sleep_with_stop(_IDLE_BACKOFF_SEC)
                    continue

                self._current_run_id = state.run_id
                await probe_queue.commit_used(
                    self.db_path, item, run_id=state.run_id
                )
                await db.bump_autorun_run(self.db_path, run_id=state.run_id)
                self._log(
                    "probe-begin",
                    item.prompt_text[:80] + ("…" if len(item.prompt_text) > 80 else ""),
                    run_id=state.run_id,
                    source=item.source,
                )
                # Wait for the probe task to finish. _execute_probe holds
                # the model lock for the duration of generation + verdict.
                #
                # We MUST drain state.queue concurrently. For manual probes
                # the SSE handler is the consumer; for autorun probes there
                # is none, and the queue (cap 10000) backs up after ~300
                # tokens (~33 events per token: 1 token + 32 activations),
                # causing the forwarder → run_probe pipeline to deadlock on
                # queue.put. The drained events are discarded — autorun
                # reads the verdict from the DB after the run finishes.
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
                    source=item.source,
                )
                self._current_run_id = None

                # Decide whether to kick the proposer in the background — do
                # this OUTSIDE the model lock so it doesn't block the next
                # autorun probe.
                await self._maybe_kick_proposer()

                # Inter-probe gap; checks stop every interval.
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
        """Sleep up to `total` seconds, breaking early if stop is requested.
        Polls every 0.5s — fine-grained enough that the user sees the loop
        halt immediately without burning CPU."""
        elapsed = 0.0
        step = 0.5
        while elapsed < total and not self._stop_requested:
            await asyncio.sleep(min(step, total - elapsed))
            elapsed += step

    async def _maybe_kick_proposer(self) -> None:
        """If queue depth is below the trigger threshold and no proposer
        run is currently in flight, spawn one."""
        depth = await probe_queue.queue_depth(self.db_path)
        if depth["total_remaining"] >= settings.proposer_trigger_depth:
            return
        if self._proposer.state == "running":
            return
        # Lazy-import the proposer orchestrator so the controller doesn't
        # have a hard dep on Phase 3 being built yet — if proposer.py
        # is missing or its dependencies aren't installed the autorun
        # loop just logs and idles.
        try:
            from . import proposer
        except ImportError as exc:
            self._log("proposer", f"proposer module unavailable: {exc}")
            return

        self._log(
            "proposer",
            f"queue depth {depth['total_remaining']} < trigger "
            f"{settings.proposer_trigger_depth}; kicking proposer",
        )
        self._proposer.state = "running"
        self._proposer.started_at = time.time()
        self._proposer.finished_at = None
        self._proposer.last_error = None
        self._proposer_task = asyncio.create_task(
            self._run_proposer(proposer)
        )

    async def _run_proposer(self, proposer_mod) -> None:
        try:
            count = await proposer_mod.run_proposer(self.db_path)
            self._proposer.last_count = count
            self._proposer.state = "idle"
            self._proposer.finished_at = time.time()
            self._log(
                "proposer",
                f"proposer added {count} new probes",
            )
        except Exception as exc:
            self._proposer.state = "failed"
            self._proposer.finished_at = time.time()
            self._proposer.last_error = str(exc)
            self._log("error", f"proposer failed: {exc}")

    def status_snapshot(self) -> dict:
        return {
            "running": self._running,
            "stop_requested": self._stop_requested,
            "current_run_id": self._current_run_id,
            "proposer": {
                "state": self._proposer.state,
                "started_at": self._proposer.started_at,
                "finished_at": self._proposer.finished_at,
                "last_count": self._proposer.last_count,
                "last_error": self._proposer.last_error,
            },
        }
