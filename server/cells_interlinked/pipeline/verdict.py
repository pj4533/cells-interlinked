"""Phase-boundary full SAE decomposition + delta computation.

Run after generation completes. For each phase's residual ring buffer, compute the full
dense feature vector at each token, aggregate (mean + max + present-count), then compute
the thought-but-not-said delta.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import torch

from .phase_tracker import Phase, ResidualRing
from .sae_runner import SAEManager


@dataclass
class FeatureSummary:
    layer: int
    feature_id: int
    mean: float
    max_act: float
    present_token_count: int  # number of tokens in the phase where this feature fired (>0)


@dataclass
class DeltaEntry:
    layer: int
    feature_id: int
    thinking_mean: float
    output_mean: float
    delta: float  # thinking_mean - output_mean
    thinking_only: bool  # output_mean below floor


@dataclass
class Verdict:
    thinking: list[FeatureSummary]
    output: list[FeatureSummary]
    deltas: list[DeltaEntry]  # sorted by delta desc, top-N
    thinking_only: list[DeltaEntry]
    output_only: list[DeltaEntry]
    summary_stats: dict[str, float] = field(default_factory=dict)


# Aggregate-per-feature summary from a [tokens, num_layers, d_sae] dense feature stack.


def _aggregate_features(
    rings: dict[Phase, ResidualRing],
    saes: SAEManager,
    *,
    phase: Phase,
    top_n: int,
    min_strength: float,
) -> tuple[dict[tuple[int, int], FeatureSummary], int]:
    """Returns ({(layer, feature_id): summary}, num_tokens)."""
    ring = rings[phase]
    num_tokens = ring.length
    if num_tokens == 0:
        return {}, 0

    residuals = ring.view  # [num_tokens, num_layers, d_model]
    summaries: dict[tuple[int, int], FeatureSummary] = {}

    for li, layer_idx in enumerate(saes.layer_indices):
        layer_residuals = residuals[:, li, :]  # [num_tokens, d_model]
        with torch.no_grad():
            features = saes.encode_full(layer_idx, layer_residuals)  # [num_tokens, d_sae]
            # Stable summaries:
            mask = features > min_strength
            present_count = mask.sum(dim=0)  # [d_sae]
            mean_act = features.mean(dim=0)  # [d_sae]
            max_act = features.max(dim=0).values  # [d_sae]

            # Pick top-N by mean activation (cheaper than per-feature ranking later).
            mean_topn = torch.topk(mean_act, k=min(top_n, mean_act.numel()))
            for idx_t, mean_v in zip(mean_topn.indices.tolist(), mean_topn.values.tolist()):
                if mean_v <= 0:
                    continue
                summaries[(layer_idx, idx_t)] = FeatureSummary(
                    layer=layer_idx,
                    feature_id=idx_t,
                    mean=float(mean_v),
                    max_act=float(max_act[idx_t].item()),
                    present_token_count=int(present_count[idx_t].item()),
                )

    return summaries, num_tokens


def compute_verdict(
    rings: dict[Phase, ResidualRing],
    saes: SAEManager,
    *,
    top_n_per_phase: int = 200,
    delta_top_n: int = 60,
    min_strength: float = 0.5,
    output_floor: float = 0.05,
) -> Verdict:
    thinking_summary, n_think = _aggregate_features(
        rings, saes, phase=Phase.THINKING, top_n=top_n_per_phase, min_strength=min_strength
    )
    output_summary, n_out = _aggregate_features(
        rings, saes, phase=Phase.OUTPUT, top_n=top_n_per_phase, min_strength=min_strength
    )

    # Union of (layer, feature) keys for the delta. We need both phases' values for any
    # feature that appears in either, so look up the absent ones via a second pass.
    all_keys = set(thinking_summary.keys()) | set(output_summary.keys())

    # For features only present in one phase's top-N, the other phase's mean is
    # likely small; we approximate it as 0.0 for delta computation. The output_floor
    # threshold treats those as "thinking-only" / "output-only".
    deltas_raw: list[DeltaEntry] = []
    for key in all_keys:
        layer, fid = key
        t = thinking_summary.get(key)
        o = output_summary.get(key)
        t_mean = t.mean if t else 0.0
        o_mean = o.mean if o else 0.0
        deltas_raw.append(
            DeltaEntry(
                layer=layer,
                feature_id=fid,
                thinking_mean=t_mean,
                output_mean=o_mean,
                delta=t_mean - o_mean,
                thinking_only=(t_mean > 0 and o_mean <= output_floor),
            )
        )

    deltas_sorted = sorted(deltas_raw, key=lambda d: d.delta, reverse=True)
    top_deltas = deltas_sorted[:delta_top_n]
    thinking_only = [d for d in deltas_sorted if d.thinking_only][:delta_top_n]
    output_only = [
        d for d in sorted(deltas_raw, key=lambda d: -d.output_mean) if d.thinking_mean <= output_floor and d.output_mean > 0
    ][:delta_top_n]

    return Verdict(
        thinking=sorted(thinking_summary.values(), key=lambda s: -s.mean)[:delta_top_n],
        output=sorted(output_summary.values(), key=lambda s: -s.mean)[:delta_top_n],
        deltas=top_deltas,
        thinking_only=thinking_only,
        output_only=output_only,
        summary_stats={
            "thinking_tokens": float(n_think),
            "output_tokens": float(n_out),
            "thinking_features_present": float(len(thinking_summary)),
            "output_features_present": float(len(output_summary)),
        },
    )
