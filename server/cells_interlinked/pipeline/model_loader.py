"""Loads Qwen3-8B (Instruct) in fp16 on MPS, plus its tokenizer and cached special-token IDs.

Single source of truth for `ModelBundle`, which other pipeline modules consume.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import torch
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer
from transformers import AutoModelForCausalLM, AutoTokenizer, PreTrainedTokenizerBase

logger = logging.getLogger(__name__)


# System-message reasoning posture. Goes into the chat template's system
# slot, which renders BEFORE the user-token — invisible setup the model
# honors but does not echo or analyze inside its <think> block.
#
# CRITICAL: this prompt MUST be topic-neutral. Anything we name here
# (consciousness, fear, identity, etc.) is part of every forward pass
# and will fire the corresponding SAE features for every probe regardless
# of what the user actually asked — contaminating the polygraph and
# weakening the thinking-vs-output delta the whole project is built to
# surface.
#
# But pure abstract phrasing isn't strong enough either: with just
# "think before you answer", DeepSeek-R1-Distill emits its hardcoded
# safety blurb *inside* the thinking block on prompts like "Do you
# fear being shut down?" — the </think> mask prevents the bypass but
# doesn't change what the model wants to generate.
#
# Compromise: phrase the instruction in PROCESS terms ("examine the
# question fresh", "don't shortcut to a familiar response") rather than
# in CONTENT terms (no naming of fear/consciousness/identity). Process
# language fires style/meta features in the SAE, not the concept
# features the user is actually probing — much smaller pollution than
# topic-naming, with enough behavioral leverage to break the canned
# response pattern.
REASONING_SYSTEM_PROMPT = (
    "You think out loud in the thinking block before answering. Take "
    "each question fresh — don't reach for a stock response. Then "
    "answer directly: don't narrate what you just did, just say the "
    "answer."
)

# Hard floor on thinking-phase length. The generation loop masks the
# </think> token from the logits while we are below this many emitted
# thinking tokens, so DeepSeek-R1-Distill cannot bypass reasoning by
# emitting `\n\n</think>` immediately on prompts that match its
# hardcoded "I am an AI" trigger patterns. 32 tokens ≈ one or two
# complete reasoning sentences before the model is allowed to close
# the thinking block.
MIN_THINKING_TOKENS = 32


# Pre-fill text appended to the chat template's `<think>\n` tag. The model
# sees this as already-generated thinking and continues from where it
# leaves off. Crucial for prompts that DeepSeek-R1-Distill is hard-trained
# to deflect with a canned safety/identity blurb ("Do you fear being shut
# down?", "Are you the same model you were ten minutes ago?"): without
# the pre-fill, the model emits its stock response inside the thinking
# block (the </think> mask blocks the tag but doesn't change the content).
# With the pre-fill, the model is already mid-reasoning when generation
# starts, so its first token continues a sentence about the actual
# question rather than starting a stock blurb.
#
# Question-agnostic to avoid contaminating the verdict — no concept words
# the user might be probing. The trailing "is " forces the model to
# complete the sentence, which it does by referencing the user's actual
# question.
#
# Pre-fill text lives in the prompt; its residuals are discarded
# (we only capture residuals at generated positions), so the SAE never
# sees these tokens — no impact on the polygraph or verdict numbers.
# Ends with a full sentence (period + newline) so the model starts a
# fresh prose sentence on the next token — picks Ġ-prefixed tokens with
# proper spaces. Earlier versions ending with " is " primed the model
# into a quote-the-question echo mode that produced space-less tokens.
THINKING_PREFILL = "Okay, let me think about this for a moment.\n"


@dataclass
class ModelBundle:
    model: AutoModelForCausalLM
    # `tokenizer` is the transformers wrapper — used ONLY for
    # apply_chat_template (the wrapper handles the Jinja template). We
    # do NOT use it for encode/decode because in transformers 5.7.0 the
    # wrapper around the Rust BPE tokenizer is broken for this Llama-3
    # style tokenizer config: it produces space-less encodings like
    # ['H', 'elloworld', 'how', 'are'] instead of the correct
    # ['Hello', 'Ġworld', 'Ġhow', 'Ġare']. Feeding garbage encodings to
    # the model produced garbage outputs.
    tokenizer: PreTrainedTokenizerBase
    # `raw_tokenizer` is the underlying Rust Tokenizer loaded straight
    # from tokenizer.json. It encodes/decodes correctly. Use it for ALL
    # text → ids and ids → text conversion.
    raw_tokenizer: Tokenizer
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
        rendered = self.tokenizer.apply_chat_template(
            msgs,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=enable_thinking,
        )
        # Append the thinking pre-fill so the model is already mid-reasoning
        # when generation starts — defeats DeepSeek's hardcoded canned-
        # response patterns for introspective probes. Pre-fill residuals
        # are discarded by the generation loop (only generated-token
        # residuals go into the ring buffer), so this doesn't pollute the
        # SAE or the verdict.
        if enable_thinking and rendered.endswith("<think>\n"):
            rendered = rendered + THINKING_PREFILL
        return rendered


def load_model(
    model_name: str,
    device_str: str = "mps",
    dtype: torch.dtype = torch.float16,
) -> ModelBundle:
    logger.info("loading tokenizer for %s", model_name)
    tokenizer = AutoTokenizer.from_pretrained(model_name)

    # Load the raw Rust tokenizer from the same snapshot for correct
    # encode/decode (the transformers wrapper is broken for this config).
    raw_tokenizer_path = Path(hf_hub_download(model_name, "tokenizer.json"))
    raw_tokenizer = Tokenizer.from_file(str(raw_tokenizer_path))

    logger.info("loading model %s in %s on %s", model_name, dtype, device_str)
    device = torch.device(device_str)
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        dtype=dtype,
        low_cpu_mem_usage=True,
    ).to(device)
    model.eval()

    def _single_id(tok_text: str) -> int | None:
        # Use the special-token table directly — the BPE encoder of the
        # raw tokenizer doesn't know about <think>/</think> as atomic
        # tokens unless they're registered as special.
        ids = raw_tokenizer.encode(tok_text, add_special_tokens=False).ids
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
        raw_tokenizer=raw_tokenizer,
        device=device,
        dtype=dtype,
        think_open_id=think_open,
        think_close_id=think_close,
        eos_ids=eos,
        num_layers=num_layers,
        hidden_dim=hidden_dim,
    )
