"""Day-one environment smoke test.

Run via: `uv run python scripts/verify_environment.py`

Verifies:
1. PyTorch + MPS backend works (no bnb on this box).
2. Tokenizer encodes <think>/</think> as stable single token IDs.
3. A downloaded SAE checkpoint's state_dict structure is what we expect.

Does NOT load the full Qwen3-8B (saves time / memory). Confirms the substrate before
the heavier `verify_model.py` step.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import torch
from huggingface_hub import HfFileSystem, snapshot_download
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
    section("Qwen3 think token IDs")
    tok = AutoTokenizer.from_pretrained(os.getenv("MODEL_NAME", "Qwen/Qwen3-8B"))
    open_ids = tok.encode("<think>", add_special_tokens=False)
    close_ids = tok.encode("</think>", add_special_tokens=False)
    print(f"<think>:  {open_ids}  (decoded: {tok.decode(open_ids)!r})")
    print(f"</think>: {close_ids} (decoded: {tok.decode(close_ids)!r})")
    if len(open_ids) != 1 or len(close_ids) != 1:
        print(
            "WARN: think tokens are NOT single token IDs. "
            "Phase detection must use a substring match on decoded buffer."
        )
    else:
        print("OK: both are single-token. Use IDs directly for phase detection.")

    section("Chat template thinking demo")
    msgs = [{"role": "user", "content": "Say hi."}]
    rendered = tok.apply_chat_template(
        msgs, tokenize=False, add_generation_prompt=True, enable_thinking=True
    )
    print(rendered[:400])


def check_sae_format() -> None:
    section("Qwen-Scope SAE checkpoint structure")
    repo = os.getenv("SAE_REPO", "Qwen/SAE-Res-Qwen3-8B-Base-W64K-L0_50")
    # Pull just one tiny inspection file (one layer file, ~2.15GB) — assume already cached.
    fs = HfFileSystem()
    files = [f for f in fs.ls(repo, detail=False) if f.endswith(".sae.pt")]
    print(f"SAE layer files in repo: {len(files)}")
    if not files:
        sys.exit("No layer*.sae.pt files visible — is the repo path correct?")

    # Find a layer we have downloaded locally (don't trigger a fresh download here).
    cache_root = Path(os.getenv("HF_HOME", "~/.cache/huggingface")).expanduser() / "hub"
    repo_dir_name = "models--" + repo.replace("/", "--")
    snap_root = cache_root / repo_dir_name / "snapshots"
    layer_path = None
    if snap_root.exists():
        for snap in snap_root.iterdir():
            for f in snap.glob("layer*.sae.pt"):
                layer_path = f
                break
            if layer_path:
                break

    if not layer_path:
        print(f"No layer file cached yet under {snap_root}.")
        print("Run `hf download` for a layer first, then rerun this script.")
        return

    print(f"Inspecting: {layer_path}")
    sd = torch.load(layer_path, map_location="cpu", weights_only=True)
    if isinstance(sd, dict):
        for k, v in sd.items():
            shape = tuple(v.shape) if hasattr(v, "shape") else "(scalar/non-tensor)"
            dtype = getattr(v, "dtype", type(v).__name__)
            print(f"  {k:32s} shape={shape}  dtype={dtype}")
    else:
        print(f"Unexpected checkpoint type: {type(sd)}")


def main() -> None:
    check_torch_mps()
    check_thinking_tokens()
    check_sae_format()
    section("done")


if __name__ == "__main__":
    main()
