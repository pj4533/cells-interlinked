"""Qwen-Scope SAE loader and runner.

The Qwen-Scope release (2026-05-01) ships per-layer `.sae.pt` files. Each contains a
state_dict; the exact key names are inspected at load time so we adapt to plain top-K
vs JumpReLU formats without hard-coding either.

Two execution paths:
  - encode_topk(residual, k):       streaming — fast, just the top-K indices/values.
  - encode_full(residual):          phase-boundary verdict — full dense feature vector.

The decoder is loaded lazily for layers whose `decode()` actually gets called, since
we only need it for the verdict pass.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import torch
from huggingface_hub import hf_hub_download

logger = logging.getLogger(__name__)


# ---------- Format adaptation ----------


@dataclass
class SAEFormat:
    """How a particular checkpoint stores its parameters."""

    enc_key: str
    enc_bias_key: str | None
    dec_key: str
    dec_bias_key: str | None
    pre_bias_key: str | None  # b_pre / b_dec applied before encoder (subtraction)
    threshold_key: str | None  # JumpReLU thresholds
    enc_transposed: bool  # True if W_enc is [d_sae, d_model] rather than [d_model, d_sae]
    dec_transposed: bool


def _infer_format(state_dict: dict[str, torch.Tensor], d_model: int) -> SAEFormat:
    """Infer parameter naming and orientation from a checkpoint."""
    keys = set(state_dict.keys())
    pick = lambda *cands: next((k for k in cands if k in keys), None)  # noqa: E731

    enc_key = pick("W_enc", "encoder.weight", "W_E", "encoder.W")
    dec_key = pick("W_dec", "decoder.weight", "W_D", "decoder.W")
    if enc_key is None or dec_key is None:
        raise ValueError(f"Cannot find encoder/decoder weights. Keys: {sorted(keys)}")

    enc_bias_key = pick("b_enc", "encoder.bias", "b_E")
    dec_bias_key = pick("b_dec", "decoder.bias", "b_D")
    pre_bias_key = pick("b_pre", "pre_bias")
    threshold_key = pick("threshold", "log_threshold", "jumprelu_threshold")

    # Orientation: hidden dim must be d_model on one axis.
    enc_shape = tuple(state_dict[enc_key].shape)
    enc_transposed = enc_shape[0] != d_model  # if [d_sae, d_model], transposed
    dec_shape = tuple(state_dict[dec_key].shape)
    dec_transposed = dec_shape[0] == d_model  # if [d_model, d_sae], transposed (we want [d_sae, d_model])

    return SAEFormat(
        enc_key=enc_key,
        enc_bias_key=enc_bias_key,
        dec_key=dec_key,
        dec_bias_key=dec_bias_key,
        pre_bias_key=pre_bias_key,
        threshold_key=threshold_key,
        enc_transposed=enc_transposed,
        dec_transposed=dec_transposed,
    )


# ---------- One-layer SAE ----------


class QwenScopeSAE:
    """SAE for a single transformer layer's residual stream.

    Holds encoder weights always; decoder is loaded on first decode() call.
    Inputs are assumed to be on `device` already; we don't cross-device-move silently.
    """

    def __init__(
        self,
        layer_idx: int,
        ckpt_path: Path,
        d_model: int,
        d_sae: int,
        device: torch.device,
        dtype: torch.dtype = torch.float16,
    ) -> None:
        self.layer_idx = layer_idx
        self.ckpt_path = ckpt_path
        self.d_model = d_model
        self.d_sae = d_sae
        self.device = device
        self.dtype = dtype

        sd = torch.load(ckpt_path, map_location="cpu", weights_only=True)
        self.fmt = _infer_format(sd, d_model)
        logger.info(
            "layer %d format: enc=%s thr=%s pre_bias=%s",
            layer_idx,
            self.fmt.enc_key,
            self.fmt.threshold_key,
            self.fmt.pre_bias_key,
        )

        # Encoder: stored as [d_model, d_sae] for matmul x @ W; transpose if needed.
        w_enc = sd[self.fmt.enc_key]
        if self.fmt.enc_transposed:
            w_enc = w_enc.T.contiguous()
        self.W_enc = w_enc.to(device=device, dtype=dtype)

        self.b_enc = (
            sd[self.fmt.enc_bias_key].to(device=device, dtype=dtype)
            if self.fmt.enc_bias_key
            else torch.zeros(d_sae, device=device, dtype=dtype)
        )
        self.b_pre = (
            sd[self.fmt.pre_bias_key].to(device=device, dtype=dtype)
            if self.fmt.pre_bias_key
            else None
        )

        if self.fmt.threshold_key:
            t = sd[self.fmt.threshold_key]
            # log-thresholds are stored as logs; convert to linear if so.
            if "log" in self.fmt.threshold_key:
                t = t.exp()
            self.threshold = t.to(device=device, dtype=dtype)
        else:
            self.threshold = None

        # Decoder loaded lazily.
        self._sd_full = sd
        self.W_dec: torch.Tensor | None = None
        self.b_dec: torch.Tensor | None = None

    def _ensure_decoder(self) -> None:
        if self.W_dec is not None:
            return
        sd = self._sd_full
        w_dec = sd[self.fmt.dec_key]
        if self.fmt.dec_transposed:
            w_dec = w_dec.T.contiguous()
        self.W_dec = w_dec.to(device=self.device, dtype=self.dtype)
        self.b_dec = (
            sd[self.fmt.dec_bias_key].to(device=self.device, dtype=self.dtype)
            if self.fmt.dec_bias_key
            else torch.zeros(self.d_model, device=self.device, dtype=self.dtype)
        )

    def drop_full_state(self) -> None:
        """Free the cached CPU state_dict once both encoder and (if used) decoder loaded."""
        self._sd_full = None  # type: ignore[assignment]

    @torch.no_grad()
    def encode(self, residual: torch.Tensor) -> torch.Tensor:
        """Dense feature vector. residual: [..., d_model] -> [..., d_sae]."""
        x = residual
        if self.b_pre is not None:
            x = x - self.b_pre
        z = x @ self.W_enc + self.b_enc
        if self.threshold is not None:
            # JumpReLU: pass through where z > threshold, else 0.
            z = torch.where(z > self.threshold, z, torch.zeros_like(z))
        else:
            z = torch.relu(z)
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
        """Reconstruction. dense_features: [..., d_sae] -> [..., d_model]."""
        self._ensure_decoder()
        return dense_features @ self.W_dec + self.b_dec  # type: ignore[operator]


# ---------- Manager ----------


class SAEManager:
    """Loads a chosen subset of per-layer SAEs and routes residuals to them."""

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
        self.layers: dict[int, QwenScopeSAE] = {}

    def load(self) -> None:
        for idx in self.layer_indices:
            ckpt = hf_hub_download(repo_id=self.repo_id, filename=f"layer{idx}.sae.pt")
            self.layers[idx] = QwenScopeSAE(
                layer_idx=idx,
                ckpt_path=Path(ckpt),
                d_model=self.d_model,
                d_sae=self.d_sae,
                device=self.device,
                dtype=self.dtype,
            )
            logger.info("loaded SAE layer %d from %s", idx, ckpt)

    def encode_topk(
        self, layer_idx: int, residual: torch.Tensor, k: int
    ) -> tuple[torch.Tensor, torch.Tensor]:
        return self.layers[layer_idx].encode_topk(residual, k)

    def encode_full(self, layer_idx: int, residual: torch.Tensor) -> torch.Tensor:
        return self.layers[layer_idx].encode(residual)

    @property
    def num_loaded(self) -> int:
        return len(self.layers)
