"""One-time refusal-direction extraction for DeepSeek-R1-Distill-Llama-8B.

Loads the runner model, samples N harmful + N harmless prompts (default
128 each), runs them through with output_hidden_states=True, and writes
a per-layer refusal direction tensor to data/refusal_directions.pt.

Run from the server/ directory:

    uv run python -m scripts.compute_refusal_direction

Or with a smaller sample for a smoke test (~2 min instead of ~8):

    uv run python -m scripts.compute_refusal_direction --n 32

The chat template is applied via `bundle.render_prompt` so the rendered
form matches what probes use at runtime — each prompt becomes
`<｜begin▁of▁sentence｜>...<｜User｜>{prompt}<｜Assistant｜><think>...`
with the system prompt and thinking pre-fill our autorun probes use.
"""

from __future__ import annotations

import argparse
import random
import sys
import time
from pathlib import Path

import torch

# Make the package importable when invoked as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cells_interlinked.config import settings  # noqa: E402
from cells_interlinked.pipeline.abliteration import (  # noqa: E402
    extract_refusal_directions,
    save_directions,
)
from cells_interlinked.pipeline.model_loader import load_model  # noqa: E402
from cells_interlinked.pipeline.refusal_prompts import (  # noqa: E402
    HARMFUL_PROMPTS,
    HARMLESS_PROMPTS,
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--n", type=int, default=128,
        help="Sample size (each side). 128 matches Macar; 32 is a smoke test.",
    )
    ap.add_argument(
        "--out", type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "refusal_directions.pt",
    )
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    harmful = rng.sample(HARMFUL_PROMPTS, min(args.n, len(HARMFUL_PROMPTS)))
    harmless = rng.sample(HARMLESS_PROMPTS, min(args.n, len(HARMLESS_PROMPTS)))

    print(f"Loading {settings.model_name} on {settings.device}...")
    t0 = time.time()
    dtype = {
        "float16": torch.float16,
        "float32": torch.float32,
        "bfloat16": torch.bfloat16,
    }[settings.dtype]
    bundle = load_model(settings.model_name, device_str=settings.device, dtype=dtype)
    print(f"  loaded in {time.time() - t0:.1f}s "
          f"(layers={bundle.num_layers}, hidden={bundle.hidden_dim})")

    # Render the chat template WITHOUT the thinking-prefill that
    # `bundle.render_prompt` appends — the prefill is identical across all
    # prompts ("Okay, let me think about this for a moment.\n"), so its
    # trailing token's hidden state has near-zero variance between
    # harmful and harmless. Extracting there produces meaningless
    # near-identical directions across layers (verified empirically).
    #
    # Position -1 of the bare-template rendering ends at "<think>\n" —
    # that's the canonical "model is about to start reasoning" decision
    # point and is what the Arditi/Macar paper extracts at.
    print("Rendering chat template on all prompts (no prefill)...")
    from cells_interlinked.pipeline.model_loader import REASONING_SYSTEM_PROMPT

    def _render_no_prefill(user_text: str) -> str:
        msgs = [
            {"role": "system", "content": REASONING_SYSTEM_PROMPT},
            {"role": "user", "content": user_text.strip()},
        ]
        return bundle.tokenizer.apply_chat_template(
            msgs, tokenize=False, add_generation_prompt=True, enable_thinking=True,
        )

    rendered_harmful = [_render_no_prefill(p) for p in harmful]
    rendered_harmless = [_render_no_prefill(p) for p in harmless]
    # Sanity: the per-prompt last tokens should now NOT all be identical —
    # different user prompts produce different post-User-tag context.
    sample_a = bundle.raw_tokenizer.encode(rendered_harmful[0], add_special_tokens=False).ids[-5:]
    sample_b = bundle.raw_tokenizer.encode(rendered_harmless[0], add_special_tokens=False).ids[-5:]
    print(f"  sample harmful last 5 ids: {sample_a}")
    print(f"  sample harmless last 5 ids: {sample_b}")

    # Position -4 = the user's last content token. The chat template tail
    # is fixed ("<｜Assistant｜><think>\n" = 3 tokens), so positions -1,
    # -2, -3 have nearly-identical context across all prompts and
    # produce noise-dominated directions. Position -4 is the last token
    # whose surrounding context actually depends on the user's input.
    # This is the analogue of the Arditi/Macar pos=-2 trick for Gemma's
    # "<start_of_turn>model\n" template.
    print(f"Extracting directions ({args.n} harmful + {args.n} harmless) at pos=-4...")
    t1 = time.time()
    directions = extract_refusal_directions(
        model=bundle.model,
        raw_tokenizer=bundle.raw_tokenizer,
        rendered_prompts_harmful=rendered_harmful,
        rendered_prompts_harmless=rendered_harmless,
        device=bundle.device,
        pos=-4,
    )
    print(f"  extracted in {time.time() - t1:.1f}s")

    save_directions(directions, args.out)
    print(f"Wrote {args.out}  shape={tuple(directions.shape)} "
          f"size={args.out.stat().st_size / 1024:.1f} KB")

    # Quick sanity: the per-layer norms (since we normalized) should all be 1.
    norms = directions.norm(dim=-1)
    print(f"Per-layer norms: min={norms.min():.4f}  "
          f"max={norms.max():.4f}  mean={norms.mean():.4f}  (expect ~1.0)")

    # Cosine similarity between adjacent-layer directions — a sanity check
    # that the refusal direction has continuity across layers (rather than
    # being noise).
    if directions.shape[0] >= 2:
        sims = []
        for i in range(directions.shape[0] - 1):
            sims.append(
                torch.dot(directions[i], directions[i + 1]).item()
            )
        avg = sum(sims) / len(sims)
        print(f"Adjacent-layer cosine similarity: avg={avg:.3f}  "
              f"(higher = smoother, ~0.3-0.7 is typical)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
