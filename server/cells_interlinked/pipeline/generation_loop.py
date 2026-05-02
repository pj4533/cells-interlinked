"""Custom autoregressive generation with per-token residual capture and SAE encoding.

This deliberately does NOT use `model.generate()` or NNsight's tracing context. We need
deterministic per-step emission and clean cancellation, both of which are easier to
control with a hand-rolled loop on top of `model.forward(use_cache=True)`.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

import torch
import torch.nn.functional as F

from .model_loader import ModelBundle
from .phase_tracker import Phase, PhaseTracker, ResidualRing
from .sae_runner import SAEManager

logger = logging.getLogger(__name__)


# ---------- Hook bookkeeping ----------


class ResidualHooks:
    """Forward hooks on chosen decoder layers; captures the last-position residual."""

    def __init__(self, model: Any, layer_indices: list[int]) -> None:
        self.layer_indices = layer_indices
        self._captured: dict[int, torch.Tensor] = {}
        self._handles: list[Any] = []

        layers = model.model.layers
        for i in layer_indices:
            self._handles.append(layers[i].register_forward_hook(self._make_hook(i)))

    def _make_hook(self, layer_idx: int):
        def hook(_mod, _input, output):
            hidden = output[0] if isinstance(output, tuple) else output
            # hidden: [batch, seq, d_model]; we keep only the last position.
            self._captured[layer_idx] = hidden[:, -1, :].detach()

        return hook

    def stack_last(self, dtype: torch.dtype, device: torch.device) -> torch.Tensor:
        """Stack last-position residuals across hooked layers → [num_layers, d_model]."""
        rows = [self._captured[i].to(device=device, dtype=dtype).squeeze(0) for i in self.layer_indices]
        return torch.stack(rows, dim=0)

    def reset(self) -> None:
        self._captured.clear()

    def remove(self) -> None:
        for h in self._handles:
            h.remove()
        self._handles.clear()


# ---------- Sampling ----------


def _sample_next(
    logits: torch.Tensor,
    *,
    temperature: float,
    top_p: float,
    generator: torch.Generator | None,
) -> torch.Tensor:
    """logits: [vocab_size] → next token id (long, shape [])."""
    if temperature <= 0:
        return logits.argmax(dim=-1)
    z = logits / temperature
    if top_p < 1.0:
        sorted_logits, sorted_idx = z.sort(descending=True)
        probs = F.softmax(sorted_logits, dim=-1)
        cum = probs.cumsum(dim=-1)
        keep_mask = cum - probs <= top_p  # always keep at least the top
        sorted_logits = torch.where(keep_mask, sorted_logits, torch.full_like(sorted_logits, -1e30))
        z = torch.full_like(z, -1e30).scatter_(-1, sorted_idx, sorted_logits)
    probs = F.softmax(z, dim=-1)
    return torch.multinomial(probs, num_samples=1, generator=generator).squeeze(-1)


# ---------- Probe runner ----------


@dataclass
class ProbeConfig:
    temperature: float = 0.7
    top_p: float = 0.8
    top_k_stream: int = 20
    seed: int | None = 42
    # Hard ceiling — only here to prevent a true infinite loop if the model never emits EOS.
    # Set generously; ordinary probes terminate on EOS well before this.
    safety_cap: int = 32768


@dataclass
class ProbeResult:
    rings: dict[Phase, ResidualRing]
    final_phase: Phase
    total_tokens: int
    stopped_reason: str  # "eos" | "max" | "cancelled" | "ring_full"
    rendered_prompt: str
    seen_phases: set[Phase] = field(default_factory=set)


async def run_probe(
    bundle: ModelBundle,
    saes: SAEManager,
    prompt_text: str,
    cfg: ProbeConfig,
    *,
    cancel_event: asyncio.Event,
    queue: asyncio.Queue,
) -> ProbeResult:
    """Run a probe end-to-end. Pushes events to `queue`; returns ring-buffer summary.

    Event types pushed (dicts):
      {type: "phase_change", from: str | None, to: str, position: int}
      {type: "token",        phase: str, token_id: int, decoded: str, position: int}
      {type: "activation",   phase: str, position: int, layer: int,
                             features: [{id: int, strength: float}, ...]}
      {type: "stopped",      reason: str, total_tokens: int}
    Caller is responsible for the verdict computation and the trailing "verdict"/"done"
    events; this function just runs the autoregressive loop.
    """
    rendered = bundle.render_prompt(prompt_text, enable_thinking=True)
    template_pre_injects_think = "<think>" in rendered

    tracker = PhaseTracker(
        think_open_id=bundle.think_open_id,
        think_close_id=bundle.think_close_id,
        initial_phase=Phase.THINKING if template_pre_injects_think else Phase.OUTPUT,
    )
    seen_phases: set[Phase] = {tracker.current}

    rings = {
        Phase.THINKING: ResidualRing(
            num_layers=len(saes.layer_indices),
            hidden_dim=bundle.hidden_dim,
            dtype=bundle.dtype,
            device=bundle.device,
        ),
        Phase.OUTPUT: ResidualRing(
            num_layers=len(saes.layer_indices),
            hidden_dim=bundle.hidden_dim,
            dtype=bundle.dtype,
            device=bundle.device,
        ),
    }

    enc = bundle.tokenizer(rendered, return_tensors="pt")
    input_ids = enc.input_ids.to(bundle.device)

    generator = None
    if cfg.seed is not None:
        generator = torch.Generator(device=bundle.device)
        generator.manual_seed(cfg.seed)

    hooks = ResidualHooks(bundle.model, saes.layer_indices)
    stopped_reason = "max"
    total_tokens = 0

    await queue.put({
        "type": "phase_change",
        "from": None,
        "to": tracker.current.value,
        "position": 0,
    })

    try:
        # Initial prompt forward — discard prompt residuals (we only stream generation).
        with torch.no_grad():
            out = bundle.model(input_ids, use_cache=True)
        past_kv = out.past_key_values
        next_logits = out.logits[0, -1, :].float()
        hooks.reset()

        for step in range(cfg.safety_cap):
            if cancel_event.is_set():
                stopped_reason = "cancelled"
                break

            tok = _sample_next(
                next_logits, temperature=cfg.temperature, top_p=cfg.top_p, generator=generator
            )
            token_id = int(tok.item())
            decoded = bundle.tokenizer.decode([token_id], skip_special_tokens=False)

            phase_before = tracker.current
            phase_for_token = tracker.observe(token_id)
            phase_after = tracker.current

            # Forward this single token to get residuals AT this token.
            with torch.no_grad():
                out = bundle.model(
                    tok.view(1, 1).to(bundle.device),
                    past_key_values=past_kv,
                    use_cache=True,
                )
            past_kv = out.past_key_values
            next_logits = out.logits[0, -1, :].float()

            layer_residuals = hooks.stack_last(dtype=bundle.dtype, device=bundle.device)
            hooks.reset()

            # Push to ring for the phase this token belongs to.
            ring = rings[phase_for_token]
            ring.append(layer_residuals)

            # Emit token first (so the UI shows the new word before the activation cells fill in).
            await queue.put({
                "type": "token",
                "phase": phase_for_token.value,
                "token_id": token_id,
                "decoded": decoded,
                "position": step,
            })

            # Stream top-K per layer.
            for li, layer_idx in enumerate(saes.layer_indices):
                indices, values = saes.encode_topk(
                    layer_idx, layer_residuals[li], cfg.top_k_stream
                )
                await queue.put({
                    "type": "activation",
                    "phase": phase_for_token.value,
                    "position": step,
                    "layer": layer_idx,
                    "features": [
                        {"id": int(i), "strength": float(v)}
                        for i, v in zip(indices.tolist(), values.tolist())
                    ],
                })

            # Phase change announcement (after token emission).
            if phase_after != phase_before:
                seen_phases.add(phase_after)
                await queue.put({
                    "type": "phase_change",
                    "from": phase_before.value,
                    "to": phase_after.value,
                    "position": step,
                })

            total_tokens = step + 1

            if token_id in bundle.eos_ids:
                stopped_reason = "eos"
                break

    finally:
        hooks.remove()

    await queue.put({"type": "stopped", "reason": stopped_reason, "total_tokens": total_tokens})
    return ProbeResult(
        rings=rings,
        final_phase=tracker.current,
        total_tokens=total_tokens,
        stopped_reason=stopped_reason,
        rendered_prompt=rendered,
        seen_phases=seen_phases,
    )
