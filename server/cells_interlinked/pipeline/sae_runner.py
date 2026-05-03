"""Llama-Scope-R1 SAE loader and runner.

Each SAE checkpoint is a safetensors file at
  {snapshot}/400M-Slimpajama-400M-OpenR1-Math-220k/L{N}R/sae_weights.safetensors
with a sibling config.json. Format (per OpenMOSS Llama-Scope-R1-Distill):

  sae_type:                   "sae"
  hook_point_in/out:          "blocks.{N}.hook_resid_post"
  d_model:                    4096
  expansion_factor:           8        → d_sae = 32_768
  act_fn:                     "jumprelu"
  norm_activation:            "dataset-wise"
  top_k:                      50

Tensors:
  encoder.weight              [d_sae, d_model]
  encoder.bias                [d_sae]
  decoder.weight              [d_model, d_sae]
  decoder.bias                [d_model]
  log_jumprelu_threshold      [d_sae]
  dataset_average_activation_norm.{hook}: scalar — residuals are divided by
    this norm before being fed into the encoder. Crucial; without it the
    encoder sees out-of-distribution activations and almost everything is
    suppressed by the JumpReLU threshold.

Two execution paths:
  - encode_topk(residual, k):       streaming — fast, just top-K indices/values.
  - encode_full(residual):          phase-boundary verdict — full dense vector.

The decoder is loaded eagerly with the encoder; both are needed at the
phase-boundary verdict pass and the per-layer files are small (~1 GB each).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

import torch
from huggingface_hub import hf_hub_download
from safetensors.torch import load_file

logger = logging.getLogger(__name__)


# ---------- One-layer SAE ----------


@dataclass
class SAEMeta:
    """Subset of the per-layer config.json we actually use."""

    hook_point: str
    d_model: int
    d_sae: int
    top_k: int
    act_fn: str
    norm_activation: str


class LlamaScopeR1SAE:
    """SAE for a single transformer layer's residual stream (Llama-Scope-R1)."""

    def __init__(
        self,
        layer_idx: int,
        ckpt_path: Path,
        config_path: Path,
        device: torch.device,
        dtype: torch.dtype = torch.float16,
    ) -> None:
        self.layer_idx = layer_idx
        self.ckpt_path = ckpt_path
        self.device = device
        self.dtype = dtype

        cfg = json.loads(config_path.read_text())
        self.meta = SAEMeta(
            hook_point=cfg["hook_point_out"],
            d_model=cfg["d_model"],
            d_sae=cfg["d_model"] * cfg["expansion_factor"],
            top_k=cfg["top_k"],
            act_fn=cfg["act_fn"],
            norm_activation=cfg["norm_activation"],
        )

        sd = load_file(str(ckpt_path), device="cpu")

        # Encoder + bias
        w_enc = sd["encoder.weight"]  # [d_sae, d_model]
        if w_enc.shape != (self.meta.d_sae, self.meta.d_model):
            raise ValueError(
                f"layer {layer_idx} encoder shape {tuple(w_enc.shape)} "
                f"!= ({self.meta.d_sae}, {self.meta.d_model})"
            )
        # Store as [d_model, d_sae] so we can do `x @ W_enc` directly.
        self.W_enc = w_enc.T.contiguous().to(device=device, dtype=dtype)
        self.b_enc = sd["encoder.bias"].to(device=device, dtype=dtype)

        # Decoder + bias
        w_dec = sd["decoder.weight"]  # [d_model, d_sae]
        if w_dec.shape != (self.meta.d_model, self.meta.d_sae):
            raise ValueError(
                f"layer {layer_idx} decoder shape {tuple(w_dec.shape)} "
                f"!= ({self.meta.d_model}, {self.meta.d_sae})"
            )
        # Store as [d_sae, d_model] so we can do `features @ W_dec` directly.
        self.W_dec = w_dec.T.contiguous().to(device=device, dtype=dtype)
        self.b_dec = sd["decoder.bias"].to(device=device, dtype=dtype)

        # JumpReLU threshold (stored as log; convert to linear).
        log_thr = sd["log_jumprelu_threshold"]
        self.threshold = log_thr.exp().to(device=device, dtype=dtype)

        # Dataset-wise activation norm. Stored as a scalar tensor under a key
        # that includes the hook point name, e.g.
        #   dataset_average_activation_norm.blocks.15.hook_resid_post
        norm_key = f"dataset_average_activation_norm.{self.meta.hook_point}"
        if norm_key not in sd:
            # Fall back: any key that starts with the prefix.
            for k in sd:
                if k.startswith("dataset_average_activation_norm."):
                    norm_key = k
                    break
        norm = sd[norm_key]
        # Some checkpoints store as 0-d tensor, some as 1-d.
        norm_val = float(norm.item() if norm.numel() == 1 else norm.flatten()[0].item())
        if norm_val <= 0:
            raise ValueError(f"layer {layer_idx} bogus dataset norm: {norm_val}")
        self.norm_val = norm_val
        self.norm_factor = torch.tensor(norm_val, device=device, dtype=dtype)

    @torch.no_grad()
    def encode(self, residual: torch.Tensor) -> torch.Tensor:
        """Dense feature vector. residual: [..., d_model] -> [..., d_sae].

        OpenMOSS's `dataset_average_activation_norm` is misleadingly named —
        empirically, you must MULTIPLY the residual by it (not divide) for
        the JumpReLU thresholds to fire as expected. Applying the divide
        produces ~0 active features per token across all layers; multiplying
        gives ~50–500 active features per token, which matches the live top-K
        signal we see and the order of magnitude of the SAE's top_k=50 sparsity
        budget. Confirmed by probing layers 3, 15, 25 against several real
        residuals — see commit message + docs/architecture.md.
        """
        x = residual * self.norm_factor
        z = x @ self.W_enc + self.b_enc
        # JumpReLU: pass through where z > threshold, else 0.
        z = torch.where(z > self.threshold, z, torch.zeros_like(z))
        return z

    @torch.no_grad()
    def encode_topk(
        self, residual: torch.Tensor, k: int
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Streaming path. Returns (indices, values), each shaped [..., k]."""
        z = self.encode(residual)
        values, indices = torch.topk(z, k=k, dim=-1)
        return indices, values

    @torch.no_grad()
    def decode(self, dense_features: torch.Tensor) -> torch.Tensor:
        """Reconstruction. dense_features: [..., d_sae] -> [..., d_model].

        Multiplies back by the dataset norm so the reconstruction lives in the
        same scale as the original residual.
        """
        x = dense_features @ self.W_dec + self.b_dec
        return x * self.norm_factor


# ---------- Manager ----------


class SAEManager:
    """Loads a chosen subset of per-layer SAEs and routes residuals to them."""

    # Subdirectory inside the OpenMOSS-Team/Llama-Scope-R1-Distill repo whose
    # SAE labels are populated on Neuronpedia (the "slimpj-openr1" variant).
    REPO_SUBDIR = "400M-Slimpajama-400M-OpenR1-Math-220k"

    def __init__(
        self,
        repo_id: str,
        layer_indices: list[int],
        d_model: int,
        d_sae: int,
        device: torch.device,
        dtype: torch.dtype = torch.float16,
    ) -> None:
        self.repo_id = repo_id
        self.layer_indices = list(layer_indices)
        self.d_model = d_model
        self.d_sae = d_sae
        self.device = device
        self.dtype = dtype
        self.layers: dict[int, LlamaScopeR1SAE] = {}

    def load(self) -> None:
        for idx in self.layer_indices:
            base = f"{self.REPO_SUBDIR}/L{idx}R"
            ckpt = hf_hub_download(repo_id=self.repo_id, filename=f"{base}/sae_weights.safetensors")
            cfg = hf_hub_download(repo_id=self.repo_id, filename=f"{base}/config.json")
            sae = LlamaScopeR1SAE(
                layer_idx=idx,
                ckpt_path=Path(ckpt),
                config_path=Path(cfg),
                device=self.device,
                dtype=self.dtype,
            )
            self.layers[idx] = sae
            logger.info(
                "loaded SAE layer %d  hook=%s  d_sae=%d  norm=%.3f",
                idx,
                sae.meta.hook_point,
                sae.meta.d_sae,
                sae.norm_val,
            )

    def encode_topk(
        self, layer_idx: int, residual: torch.Tensor, k: int
    ) -> tuple[torch.Tensor, torch.Tensor]:
        return self.layers[layer_idx].encode_topk(residual, k)

    def encode_full(self, layer_idx: int, residual: torch.Tensor) -> torch.Tensor:
        return self.layers[layer_idx].encode(residual)

    @property
    def num_loaded(self) -> int:
        return len(self.layers)

    def unload(self) -> None:
        """Drop every per-layer SAE so the parent process can free its
        residency back to the OS before spawning the proposer subprocess.
        Caller is responsible for `torch.mps.empty_cache()` + `gc.collect()`
        after this returns."""
        for sae in self.layers.values():
            for attr in ("W_enc", "b_enc", "W_dec", "b_dec", "threshold", "norm_factor"):
                if hasattr(sae, attr):
                    setattr(sae, attr, None)
        self.layers.clear()
