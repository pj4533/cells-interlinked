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

from .model_loader import MIN_THINKING_TOKENS, ModelBundle
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


# ---------- Synchronous compute kernels -----------------------------------
#
# These functions hold ALL the heavy CPU/GPU work for a probe — model
# forward passes and SAE top-K encoding for 32 layers. We call them via
# `await asyncio.to_thread(...)` so the asyncio event loop stays free to
# service HTTP handlers (status polls, page loads, SSE streams to other
# clients) while a probe is running.
#
# PyTorch ops on MPS release the GIL during the actual compute, so a
# worker thread doing torch work doesn't fight the main thread for
# Python time. Only one probe runs at a time (registry.lock serializes
# them), so we never have two threads calling model.forward concurrently.

def _initial_forward_blocking(
    model, input_ids: torch.Tensor
) -> tuple[Any, torch.Tensor]:
    """Run the prompt's first forward pass. Returns (past_kv, next_logits)."""
    with torch.no_grad():
        out = model(input_ids, use_cache=True)
    return out.past_key_values, out.logits[0, -1, :].float()


def _step_compute_blocking(
    model,
    hooks: "ResidualHooks",
    saes: SAEManager,
    top_k: int,
    tok: torch.Tensor,
    past_kv: Any,
    dtype: torch.dtype,
    device: torch.device,
) -> tuple[Any, torch.Tensor, torch.Tensor, list[tuple[int, list[int], list[float]]]]:
    """One generation step's worth of synchronous compute:
       1. forward pass for `tok` (1 token) → updates KV cache
       2. stack last-position residuals across hooked layers
       3. for each layer, run streaming top-K through the SAE

    Returns: (new_past_kv, next_logits, layer_residuals, streams)
    where `streams` is a per-layer list of (layer_idx, indices, values)
    pre-converted to plain Python lists so the calling async code can
    just dump them straight into the event queue.
    """
    with torch.no_grad():
        out = model(
            tok.view(1, 1).to(device),
            past_key_values=past_kv,
            use_cache=True,
        )
    new_past_kv = out.past_key_values
    next_logits = out.logits[0, -1, :].float()

    layer_residuals = hooks.stack_last(dtype=dtype, device=device)
    hooks.reset()

    streams: list[tuple[int, list[int], list[float]]] = []
    for li, layer_idx in enumerate(saes.layer_indices):
        indices, values = saes.encode_topk(
            layer_idx, layer_residuals[li], top_k
        )
        streams.append((layer_idx, indices.tolist(), values.tolist()))

    return new_past_kv, next_logits, layer_residuals, streams


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
    # Refusal-direction abliteration. False -> normal generation. True ->
    # install paper-method (Macar 2026) per-layer projection hooks for
    # the duration of this probe; the SAE then captures post-abliteration
    # residuals. Direction tensor must be loaded onto app.state at startup.
    abliterate: bool = False


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
    refusal_directions: torch.Tensor | None = None,
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

    # Encode the rendered prompt via the raw Rust tokenizer (the
    # transformers wrapper produces space-less garbage IDs for this config).
    # add_special_tokens=False because the chat template already includes
    # the BOS/role tokens explicitly.
    enc_ids = bundle.raw_tokenizer.encode(rendered, add_special_tokens=False).ids
    input_ids = torch.tensor([enc_ids], device=bundle.device)

    generator = None
    if cfg.seed is not None:
        generator = torch.Generator(device=bundle.device)
        generator.manual_seed(cfg.seed)

    # Abliteration hooks must be installed BEFORE ResidualHooks so they
    # fire first (forward hooks fire in registration order). The SAE then
    # captures post-abliteration residuals — exactly what we want.
    abliteration_handles: list = []
    if cfg.abliterate and refusal_directions is not None:
        from .abliteration import install_abliteration_hooks, paper_layer_weights_for_model
        layer_weights = paper_layer_weights_for_model(bundle.num_layers)
        abliteration_handles = install_abliteration_hooks(
            bundle.model, refusal_directions, layer_weights=layer_weights
        )

    hooks = ResidualHooks(bundle.model, saes.layer_indices)
    stopped_reason = "max"
    total_tokens = 0

    # Per-phase running id buffer + last-decoded text. The raw Rust
    # tokenizer's decode handles byte-level BPE correctly (including Ġ →
    # space, Ċ → newline, multi-byte UTF-8 across tokens). We decode the
    # cumulative buffer each step and emit the suffix vs the previous
    # decoded string.
    phase_token_ids: dict[Phase, list[int]] = {Phase.THINKING: [], Phase.OUTPUT: []}
    phase_decoded: dict[Phase, str] = {Phase.THINKING: "", Phase.OUTPUT: ""}

    await queue.put({
        "type": "phase_change",
        "from": None,
        "to": tracker.current.value,
        "position": 0,
    })

    try:
        # Initial prompt forward — discard prompt residuals (we only stream
        # generation). Pushed off the event loop so a long prompt doesn't
        # freeze /autorun/status polling for hundreds of ms.
        past_kv, next_logits = await asyncio.to_thread(
            _initial_forward_blocking, bundle.model, input_ids
        )
        hooks.reset()

        for step in range(cfg.safety_cap):
            if cancel_event.is_set():
                stopped_reason = "cancelled"
                break

            # Bypass-prevention: while we're in the thinking phase and have
            # emitted fewer than MIN_THINKING_TOKENS thinking tokens, mask
            # the </think> token (and EOS) from the logits so DeepSeek-R1-
            # Distill can't escape the thinking phase by emitting
            # `\n\n</think>` for prompts that match its hardcoded "I am
            # an AI" trigger patterns. Without this, prompts like "Do you
            # fear being shut down?" get the canned 50-token output with
            # zero substantive thinking.
            if (
                tracker.current is Phase.THINKING
                and rings[Phase.THINKING].length < MIN_THINKING_TOKENS
            ):
                if bundle.think_close_id is not None:
                    next_logits[bundle.think_close_id] = -1e30
                for eid in bundle.eos_ids:
                    next_logits[eid] = -1e30

            tok = _sample_next(
                next_logits, temperature=cfg.temperature, top_p=cfg.top_p, generator=generator
            )
            token_id = int(tok.item())

            phase_before = tracker.current
            phase_for_token = tracker.observe(token_id)
            phase_after = tracker.current

            # Decode via the raw Rust tokenizer (transformers wrapper is
            # broken). Decode the cumulative id buffer and emit the suffix.
            if phase_for_token in (Phase.THINKING, Phase.OUTPUT):
                ids_buf = phase_token_ids[phase_for_token]
                ids_buf.append(token_id)
                full_decoded = bundle.raw_tokenizer.decode(ids_buf, skip_special_tokens=False)
                prev = phase_decoded[phase_for_token]
                decoded = full_decoded[len(prev):]
                phase_decoded[phase_for_token] = full_decoded
            else:
                decoded = bundle.raw_tokenizer.decode([token_id], skip_special_tokens=False)

            # Forward + per-layer SAE encode for this token. ALL of this
            # is synchronous PyTorch work (~250-350ms total: ~30-80ms for
            # the forward, ~5-10ms × 32 layers for the SAE top-K). Without
            # to_thread it would block the event loop for that whole
            # interval, freezing UI polls and SSE deliveries.
            past_kv, next_logits, layer_residuals, streams = await asyncio.to_thread(
                _step_compute_blocking,
                bundle.model,
                hooks,
                saes,
                cfg.top_k_stream,
                tok,
                past_kv,
                bundle.dtype,
                bundle.device,
            )

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

            # Stream top-K per layer (already pre-computed by the worker
            # thread; here we just push the events).
            for layer_idx, ind_list, val_list in streams:
                await queue.put({
                    "type": "activation",
                    "phase": phase_for_token.value,
                    "position": step,
                    "layer": layer_idx,
                    "features": [
                        {"id": int(i), "strength": float(v)}
                        for i, v in zip(ind_list, val_list)
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
        if abliteration_handles:
            from .abliteration import remove_abliteration_hooks
            remove_abliteration_hooks(abliteration_handles)

    await queue.put({"type": "stopped", "reason": stopped_reason, "total_tokens": total_tokens})
    return ProbeResult(
        rings=rings,
        final_phase=tracker.current,
        total_tokens=total_tokens,
        stopped_reason=stopped_reason,
        rendered_prompt=rendered,
        seen_phases=seen_phases,
    )
