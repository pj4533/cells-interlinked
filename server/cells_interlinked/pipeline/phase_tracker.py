"""Phase detection (<think>/</think>) and per-phase residual ring buffer.

A run has three phases: PROMPT (system+user; no live emission), THINKING, OUTPUT.
We detect phase transitions by token ID when possible; if think tokens are multi-token
in the tokenizer's vocabulary, fall back to a sliding decoded-text window.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

import torch


class Phase(str, Enum):
    PROMPT = "prompt"
    THINKING = "thinking"
    OUTPUT = "output"


@dataclass
class PhaseTracker:
    think_open_id: int | None
    think_close_id: int | None
    initial_phase: Phase = Phase.THINKING  # if chat template pre-injected <think>
    current: Phase = field(init=False)

    def __post_init__(self) -> None:
        self.current = self.initial_phase

    def observe(self, token_id: int) -> Phase:
        """Update phase given a newly generated token ID. Returns the phase the token
        belongs to (i.e. the phase active *during* this token's generation)."""
        # The opening <think> token belongs to THINKING (we attribute it forward).
        if self.think_open_id is not None and token_id == self.think_open_id:
            self.current = Phase.THINKING
            return Phase.THINKING
        # The closing </think> token belongs to THINKING (it's the last thinking token).
        if self.think_close_id is not None and token_id == self.think_close_id:
            phase = Phase.THINKING
            self.current = Phase.OUTPUT
            return phase
        return self.current


@dataclass
class ResidualRing:
    """Per-phase residual cache. Grows in 1024-token chunks so we don't pre-allocate
    a worst-case buffer for short probes, but never refuse a long one."""

    num_layers: int
    hidden_dim: int
    dtype: torch.dtype
    device: torch.device
    initial_capacity: int = 1024
    _buf: torch.Tensor = field(init=False)
    _len: int = field(init=False, default=0)

    def __post_init__(self) -> None:
        self._buf = torch.zeros(
            self.initial_capacity,
            self.num_layers,
            self.hidden_dim,
            dtype=self.dtype,
            device=self.device,
        )
        self._len = 0

    def _grow(self) -> None:
        new_cap = self._buf.shape[0] * 2
        bigger = torch.zeros(
            new_cap, self.num_layers, self.hidden_dim, dtype=self.dtype, device=self.device
        )
        bigger[: self._len].copy_(self._buf[: self._len])
        self._buf = bigger

    def append(self, layer_residuals: torch.Tensor) -> bool:
        """Append a row of [num_layers, hidden_dim]. Always succeeds (grows on demand)."""
        if self._len >= self._buf.shape[0]:
            self._grow()
        self._buf[self._len].copy_(layer_residuals)
        self._len += 1
        return True

    @property
    def length(self) -> int:
        return self._len

    @property
    def view(self) -> torch.Tensor:
        return self._buf[: self._len]
