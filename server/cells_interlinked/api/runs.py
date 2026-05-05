"""Per-run state held server-side. Each run has a queue, cancel event, and task handle."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field


@dataclass
class RunState:
    run_id: str
    prompt_text: str
    # Unbounded queue. The SSE handler drains this when a client connects;
    # for runs with no client, events accumulate. A bounded queue caused
    # run_probe to hang on `queue.put` once it filled — abliterated V-K
    # probes generate ~33 events per token so a 300-token run blew past
    # any small bound. Memory is ~200B/event × ~50k worst-case ≈ 10MB.
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue())
    cancel_event: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task | None = None
    completed: bool = False


class RunRegistry:
    def __init__(self) -> None:
        self._runs: dict[str, RunState] = {}
        self._lock = asyncio.Lock()  # serializes generation; one model, one stream

    def add(self, run: RunState) -> None:
        self._runs[run.run_id] = run

    def get(self, run_id: str) -> RunState | None:
        return self._runs.get(run_id)

    def remove(self, run_id: str) -> None:
        self._runs.pop(run_id, None)

    @property
    def lock(self) -> asyncio.Lock:
        return self._lock
