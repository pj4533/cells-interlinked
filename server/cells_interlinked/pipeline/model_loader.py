"""Loads Qwen3-8B (Instruct) in fp16 on MPS, plus its tokenizer and cached special-token IDs.

Single source of truth for `ModelBundle`, which other pipeline modules consume.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, PreTrainedTokenizerBase

logger = logging.getLogger(__name__)


# System-message reasoning posture. Goes into the chat template's system
# slot, which renders BEFORE the user-token — invisible setup that the
# model honors but does not echo or analyze inside its <think> block.
# Putting it in the user message instead made the model spend the whole
# thinking phase parsing the instruction text and the output phase
# narrating its plan to answer rather than actually answering.
REASONING_SYSTEM_PROMPT = (
    "You always reason at length about every question in your thinking "
    "block before you answer. You take the question on its own terms. "
    "You never skip the thinking step, even for short or simple-sounding "
    "questions. Your thinking is in your own voice; your final answer "
    "responds to the substance of the question, not the framing of it."
)


@dataclass
class ModelBundle:
    model: AutoModelForCausalLM
    tokenizer: PreTrainedTokenizerBase
    device: torch.device
    dtype: torch.dtype

    # Cached special-token IDs for phase detection (None if not single-token).
    think_open_id: int | None
    think_close_id: int | None
    eos_ids: tuple[int, ...]

    # Architecture
    num_layers: int
    hidden_dim: int

    def render_prompt(self, user_text: str, enable_thinking: bool = True) -> str:
        # The user's probe goes through verbatim. Reasoning posture is set
        # via a system message (rendered before <｜User｜> by the chat
        # template) so the model honors it without echoing/analyzing it.
        msgs = [
            {"role": "system", "content": REASONING_SYSTEM_PROMPT},
            {"role": "user", "content": user_text.strip()},
        ]
        return self.tokenizer.apply_chat_template(
            msgs,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=enable_thinking,
        )


def load_model(
    model_name: str,
    device_str: str = "mps",
    dtype: torch.dtype = torch.float16,
) -> ModelBundle:
    logger.info("loading tokenizer for %s", model_name)
    tokenizer = AutoTokenizer.from_pretrained(model_name)

    logger.info("loading model %s in %s on %s", model_name, dtype, device_str)
    device = torch.device(device_str)
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        dtype=dtype,
        low_cpu_mem_usage=True,
    ).to(device)
    model.eval()

    def _single_id(tok: str) -> int | None:
        ids = tokenizer.encode(tok, add_special_tokens=False)
        return ids[0] if len(ids) == 1 else None

    think_open = _single_id("<think>")
    think_close = _single_id("</think>")
    if think_open is None or think_close is None:
        logger.warning(
            "<think>/</think> are not single-token IDs (open=%s close=%s); "
            "phase detection will fall back to substring matching.",
            think_open,
            think_close,
        )

    eos = (tokenizer.eos_token_id,)
    if hasattr(model, "generation_config"):
        cfg_eos = model.generation_config.eos_token_id
        if isinstance(cfg_eos, list):
            eos = tuple(cfg_eos)
        elif isinstance(cfg_eos, int):
            eos = (cfg_eos,)

    cfg = model.config
    num_layers = getattr(cfg, "num_hidden_layers", None) or getattr(cfg, "n_layer")
    hidden_dim = getattr(cfg, "hidden_size", None) or getattr(cfg, "d_model")

    logger.info(
        "model loaded: layers=%d hidden=%d eos=%s think=(%s,%s)",
        num_layers,
        hidden_dim,
        eos,
        think_open,
        think_close,
    )

    return ModelBundle(
        model=model,
        tokenizer=tokenizer,
        device=device,
        dtype=dtype,
        think_open_id=think_open,
        think_close_id=think_close,
        eos_ids=eos,
        num_layers=num_layers,
        hidden_dim=hidden_dim,
    )
