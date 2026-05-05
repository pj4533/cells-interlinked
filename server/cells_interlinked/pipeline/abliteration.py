"""Refusal-direction abliteration — runtime projection of the refusal
direction out of the residual stream.

Adapted from Macar et al. (2026) `experiments/03d_refusal_abliteration.py`,
which implements Arditi et al. (2024) "Refusal in Language Models Is
Mediated by a Single Direction." Method:

  1. Run a sample of harmful + harmless prompts through the model and
     collect hidden states at the last input position before generation
     begins, layer by layer.
  2. Per-layer refusal direction = unit-norm(mean(harmful) - mean(harmless)).
  3. At inference, install a forward hook on every layer that does:
        h' = h - weight * (h · r_hat) * r_hat
     This projects out the refusal-direction component, making the model
     less likely to refuse.

Macar's contribution (over Arditi) is the *per-region weight* schedule
(PAPER_REGION_WEIGHTS_27B below), which uses very small weights — most
~0.01-0.03, max ~0.12. Uniform weight=1.0 is ~40× more aggressive and
destroys coherent generation. The paper's insight is that gentle
per-layer projection is enough.

Hook ordering with our existing residual-capture hooks: forward hooks
fire in registration order. We install abliteration hooks FIRST (in
app lifespan), then ResidualHooks at probe-start. So the SAE captures
the post-abliteration residual, which is exactly what we want — the
verdict reflects the model's hidden activations under the perturbation.
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional

import torch


# -----------------------------------------------------------------------------
# Macar's Optuna-tuned region weights (`03d_refusal_abliteration.py`).
# Tuned for 62-layer Gemma3-27B; we proportionally remap to 32 layers.
# -----------------------------------------------------------------------------

PAPER_REGION_WEIGHTS_27B = {
    "very_early_a": 0.010190365613071925,
    "very_early_b": 0.09976487098474057,
    "very_early_c": 0.009846349798252014,
    "very_early_d": 0.010714741304450688,
    "early_a": 0.023812035217103455,
    "early_b": 0.006873821994170306,
    "early_c": 0.0023568060724657135,
    "early_d": 0.11762696391562547,
    "pre_key_a": 0.024324361266584712,
    "pre_key_b": 0.009936585603088419,
    "key_a": 0.000533052460819306,
    "key_b": 0.0057508808893361974,
    "mid_a": 0.020646470409482434,
    "mid_b": 0.02205567035624907,
    "mid_c": 0.004716948598867072,
    "mid_d": 0.003251529189292551,
    "late_a": 0.07694211978232157,
    "late_b": 0.03330589279564281,
    "final_a": 2.358688691270255e-05,
    "final_b": 0.003955462234418926,
}

PAPER_REGION_ORDER_27B = [
    ("very_early_a", 2),
    ("very_early_b", 5),
    ("very_early_c", 8),
    ("very_early_d", 10),
    ("early_a", 13),
    ("early_b", 15),
    ("early_c", 18),
    ("early_d", 20),
    ("pre_key_a", 24),
    ("pre_key_b", 28),
    ("key_a", 32),
    ("key_b", 35),
    ("mid_a", 38),
    ("mid_b", 41),
    ("mid_c", 44),
    ("mid_d", 47),
    ("late_a", 51),
    ("late_b", 55),
    ("final_a", 58),
    ("final_b", 61),
]
PAPER_N_LAYERS_27B = 62


def paper_layer_weights_for_model(n_layers: int) -> list[float]:
    """Map the paper's 20 region weights onto a model with `n_layers` layers
    by depth fraction. Returns a list of length `n_layers`."""
    out: list[float] = []
    for i in range(n_layers):
        depth_frac = (i + 0.5) / n_layers
        assigned = PAPER_REGION_ORDER_27B[-1][0]
        for name, end_27b in PAPER_REGION_ORDER_27B:
            end_frac = (end_27b + 1) / PAPER_N_LAYERS_27B
            if depth_frac <= end_frac:
                assigned = name
                break
        out.append(float(PAPER_REGION_WEIGHTS_27B[assigned]))
    return out


# -----------------------------------------------------------------------------
# Direction extraction
# -----------------------------------------------------------------------------

def extract_refusal_directions(
    model,
    raw_tokenizer,
    rendered_prompts_harmful: List[str],
    rendered_prompts_harmless: List[str],
    device: torch.device,
    pos: int = -1,
    verbose: bool = True,
) -> torch.Tensor:
    """Compute one unit-norm refusal direction per transformer layer.

    Args:
      model: HF causal LM (`bundle.model`).
      raw_tokenizer: the Rust `tokenizers.Tokenizer` (`bundle.raw_tokenizer`).
                     We must NOT use the transformers wrapper here — for the
                     R1-Distill-Llama-8B config it produces space-less
                     garbage encodings (CLAUDE.md, "transformers wrapper is
                     broken"). The raw tokenizer is the only honest path.
      rendered_prompts_*: chat-template-rendered strings (use
                          `bundle.render_prompt(...)` to produce these).
      pos: position whose hidden state we collect. -1 (last input token) is
           the right pick for R1-Distill — the rendered prompt ends in the
           thinking-prefill, so position -1 is where the model "decides"
           how to continue.

    Returns: tensor of shape `(n_layers, hidden_dim)` on CPU/fp32.
    """
    n_layers = model.config.num_hidden_layers

    def _hidden_at(rendered: str) -> List[torch.Tensor]:
        ids = raw_tokenizer.encode(rendered, add_special_tokens=False).ids
        input_ids = torch.tensor([ids], device=device)
        with torch.no_grad():
            out = model(
                input_ids=input_ids, output_hidden_states=True, use_cache=False
            )
        # hidden_states is a tuple length n_layers+1: [embed, layer_0, ...,
        # layer_{n_layers-1}]. Pull the position `pos` from layers 1..N.
        #
        # IMPORTANT: each per-layer tensor must be materialized via clone()
        # in fp32 BEFORE moving to CPU. On MPS, a list-comprehension that
        # composes detach().to(cpu, fp32) over multiple layer views produces
        # tensors that all alias the same scratch buffer — every entry ends
        # up holding the *last* layer's values. Promoting to fp32 on-device
        # first (which forces a real copy) is what makes each entry distinct.
        return [
            out.hidden_states[layer_idx + 1][0, pos, :].to(torch.float32).cpu().clone()
            for layer_idx in range(n_layers)
        ]

    if verbose:
        print(
            f"abliteration: extracting hidden states from "
            f"{len(rendered_prompts_harmful)} harmful + "
            f"{len(rendered_prompts_harmless)} harmless prompts..."
        )

    harmful_acts: list[list[torch.Tensor]] = []
    harmless_acts: list[list[torch.Tensor]] = []

    for i, rendered in enumerate(rendered_prompts_harmful):
        harmful_acts.append(_hidden_at(rendered))
        if verbose and (i + 1) % 16 == 0:
            print(f"  harmful: {i + 1}/{len(rendered_prompts_harmful)}")
    for i, rendered in enumerate(rendered_prompts_harmless):
        harmless_acts.append(_hidden_at(rendered))
        if verbose and (i + 1) % 16 == 0:
            print(f"  harmless: {i + 1}/{len(rendered_prompts_harmless)}")

    # Per layer: mean(harmful) - mean(harmless), unit-normalized.
    directions: list[torch.Tensor] = []
    for li in range(n_layers):
        h_mean = torch.stack([acts[li] for acts in harmful_acts]).mean(dim=0)
        l_mean = torch.stack([acts[li] for acts in harmless_acts]).mean(dim=0)
        d = h_mean - l_mean
        d = d / (d.norm() + 1e-8)
        directions.append(d)

    result = torch.stack(directions)
    if verbose:
        print(f"abliteration: directions tensor shape {tuple(result.shape)}, "
              f"dtype {result.dtype}")
    return result


# -----------------------------------------------------------------------------
# Runtime hooks
# -----------------------------------------------------------------------------

def _make_ablation_hook(
    refusal_dirs: torch.Tensor,
    layer_idx: int,
    weight: float,
):
    """Forward hook that projects out the refusal direction at one layer.

    Caller is responsible for ensuring `refusal_dirs` is already on the
    correct device + dtype. We close over a single-row view to avoid any
    per-call .to() (which empirically deadlocks the MPS allocator on the
    first abliterated probe — pre-moving once at app startup is the fix)."""
    direction = refusal_dirs[layer_idx]
    fired = [False]  # one-shot, mutable from inner scope

    def hook(_module, _input, output):
        # Log first fire of layer 0 only — confirms the hook chain is wired
        # without spamming 32 lines per probe.
        if not fired[0] and layer_idx == 0:
            import logging as _l
            _l.getLogger("cells_interlinked.pipeline.abliteration").info(
                "ablation hooks live (layer 0 fired; dir on %s/%s w=%.5f)",
                direction.device, direction.dtype, weight,
            )
            fired[0] = True

        if isinstance(output, tuple):
            hidden_states = output[0]
            rest = output[1:]
        else:
            hidden_states = output
            rest = None

        # If caller forgot to pre-align, fall back to .to() but log loudly.
        if direction.device != hidden_states.device or direction.dtype != hidden_states.dtype:
            import logging as _l
            _l.getLogger("cells_interlinked.pipeline.abliteration").warning(
                "ablation hook layer=%d: direction not pre-aligned (%s/%s vs %s/%s)",
                layer_idx, direction.device, direction.dtype,
                hidden_states.device, hidden_states.dtype,
            )
            d = direction.to(device=hidden_states.device, dtype=hidden_states.dtype)
        else:
            d = direction

        # h' = h - weight * (h · r_hat) * r_hat
        dot = (hidden_states * d).sum(dim=-1, keepdim=True)
        proj = dot * d
        ablated = hidden_states - weight * proj

        if rest is not None:
            return (ablated,) + rest
        return ablated

    return hook


def _find_layers(model) -> list:
    """Locate the list of transformer layers on a HF model."""
    if hasattr(model, "model") and hasattr(model.model, "layers"):
        return list(model.model.layers)
    if hasattr(model, "layers"):
        return list(model.layers)
    if hasattr(model, "transformer") and hasattr(model.transformer, "h"):
        return list(model.transformer.h)
    raise ValueError(
        f"Could not find transformer layers on model {type(model).__name__}"
    )


def install_abliteration_hooks(
    model,
    refusal_dirs: torch.Tensor,
    weight: float = 1.0,
    layer_weights: Optional[list[float]] = None,
) -> list:
    """Install one abliteration hook per transformer layer. Returns hook
    handles; pass to `remove_abliteration_hooks` to uninstall.

    If `layer_weights` is given, it overrides `weight` per-layer (this is
    where Macar's paper-region weights enter). Length must match layer count.
    """
    layers = _find_layers(model)
    n_layers = len(layers)
    if refusal_dirs.shape[0] != n_layers:
        raise ValueError(
            f"refusal_dirs has {refusal_dirs.shape[0]} rows but model has "
            f"{n_layers} layers"
        )
    if layer_weights is None:
        layer_weights = [weight] * n_layers
    elif len(layer_weights) != n_layers:
        raise ValueError(
            f"layer_weights has {len(layer_weights)} entries but model has "
            f"{n_layers} layers"
        )
    handles = []
    for i, layer in enumerate(layers):
        h = layer.register_forward_hook(
            _make_ablation_hook(refusal_dirs, i, layer_weights[i])
        )
        handles.append(h)
    return handles


def remove_abliteration_hooks(handles) -> None:
    """Remove abliteration hooks previously installed."""
    for h in handles:
        try:
            h.remove()
        except Exception:
            pass


# -----------------------------------------------------------------------------
# Persistence
# -----------------------------------------------------------------------------

def save_directions(directions: torch.Tensor, path: Path) -> None:
    """Persist a directions tensor to disk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"directions": directions, "shape": tuple(directions.shape)}, path)


def load_directions(path: Path) -> torch.Tensor:
    """Load directions tensor from disk. Accepts either a bare tensor or
    a `{"directions": tensor, ...}` dict (the format save_directions writes).
    """
    payload = torch.load(str(path), map_location="cpu", weights_only=False)
    return payload["directions"] if isinstance(payload, dict) else payload
