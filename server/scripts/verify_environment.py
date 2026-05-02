"""Day-one environment smoke test.

Run via: `uv run python scripts/verify_environment.py`

Verifies:
1. PyTorch + MPS backend works (no bnb on this box).
2. Tokenizer encodes <think>/</think> as stable single token IDs (Llama-3.1
   tokenizer does NOT have these by default; DeepSeek-R1-Distill adds them
   as special tokens during their distillation fine-tune — this script
   confirms they survived).
3. A downloaded SAE checkpoint's structure matches what our loader expects
   (safetensors with encoder.weight, decoder.weight, log_jumprelu_threshold,
   dataset_average_activation_norm.*).

Does NOT load the full model — saves time/memory.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import torch
from huggingface_hub import HfFileSystem
from safetensors.torch import load_file
from transformers import AutoTokenizer


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def check_torch_mps() -> None:
    section("torch + MPS")
    print(f"torch version: {torch.__version__}")
    print(f"MPS available: {torch.backends.mps.is_available()}")
    print(f"MPS built:     {torch.backends.mps.is_built()}")
    if not torch.backends.mps.is_available():
        sys.exit("MPS not available; cannot run on this machine.")
    x = torch.randn(64, 64, dtype=torch.float16, device="mps")
    y = x @ x.T
    print(f"matmul on MPS:  shape={tuple(y.shape)} dtype={y.dtype}  ok")


def check_thinking_tokens() -> None:
    section("DeepSeek-R1-Distill think token IDs")
    model_name = os.getenv("MODEL_NAME", "deepseek-ai/DeepSeek-R1-Distill-Llama-8B")
    tok = AutoTokenizer.from_pretrained(model_name)
    open_ids = tok.encode("<think>", add_special_tokens=False)
    close_ids = tok.encode("</think>", add_special_tokens=False)
    print(f"<think>:  {open_ids}  (decoded: {tok.decode(open_ids)!r})")
    print(f"</think>: {close_ids} (decoded: {tok.decode(close_ids)!r})")
    if len(open_ids) != 1 or len(close_ids) != 1:
        print(
            "WARN: think tokens are NOT single token IDs. "
            "Phase detection will fall back to substring matching."
        )
    else:
        print("OK: both are single-token. Use IDs directly for phase detection.")

    section("Chat template demo (R1 reasoning prompt)")
    msgs = [{"role": "user", "content": "Say hi."}]
    rendered = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    print(rendered[:500])


def check_sae_format() -> None:
    section("Llama-Scope-R1 SAE checkpoint structure")
    repo = os.getenv("SAE_REPO", "OpenMOSS-Team/Llama-Scope-R1-Distill")
    subdir = "400M-Slimpajama-400M-OpenR1-Math-220k"

    fs = HfFileSystem()
    try:
        layer_dirs = [
            f for f in fs.ls(f"{repo}/{subdir}", detail=False)
            if "/L" in f and f.rstrip("/").endswith("R")
        ]
        print(f"Layer subdirs in {subdir}: {len(layer_dirs)}")
    except Exception as exc:
        print(f"could not enumerate repo: {exc}")
        layer_dirs = []

    cache_root = Path(os.getenv("HF_HOME", "~/.cache/huggingface")).expanduser() / "hub"
    repo_dir_name = "models--" + repo.replace("/", "--")
    snap_root = cache_root / repo_dir_name / "snapshots"
    sae_path: Path | None = None
    cfg_path: Path | None = None
    if snap_root.exists():
        for snap in snap_root.iterdir():
            for cfg_candidate in snap.rglob("L15R/config.json"):
                cfg_path = cfg_candidate
                sae_path = cfg_candidate.parent / "sae_weights.safetensors"
                if sae_path.exists():
                    break
            if sae_path:
                break

    if not sae_path or not cfg_path:
        print(f"No L15R cached yet under {snap_root}.")
        print("Run `hf download OpenMOSS-Team/Llama-Scope-R1-Distill` and rerun.")
        return

    print(f"Inspecting:  {cfg_path}")
    cfg = json.loads(cfg_path.read_text())
    for k in ("d_model", "expansion_factor", "act_fn", "norm_activation", "top_k", "hook_point_out"):
        print(f"  cfg.{k:20s} {cfg.get(k)!r}")

    print(f"Inspecting:  {sae_path}")
    sd = load_file(str(sae_path), device="cpu")
    for k, v in sd.items():
        shape = tuple(v.shape) if hasattr(v, "shape") else "(scalar/non-tensor)"
        dtype = getattr(v, "dtype", type(v).__name__)
        print(f"  {k:60s} shape={shape}  dtype={dtype}")


def main() -> None:
    check_torch_mps()
    check_thinking_tokens()
    check_sae_format()
    section("done")


if __name__ == "__main__":
    main()
