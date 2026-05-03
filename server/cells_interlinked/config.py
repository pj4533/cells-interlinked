"""Env-driven configuration. Loaded once at import time."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

_REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(_REPO_ROOT / ".env")


def _int_list(raw: str) -> list[int]:
    return [int(x.strip()) for x in raw.split(",") if x.strip()]


@dataclass(frozen=True)
class Settings:
    server_host: str = os.getenv("SERVER_HOST", "127.0.0.1")
    server_port: int = int(os.getenv("SERVER_PORT", "8000"))

    model_name: str = os.getenv("MODEL_NAME", "deepseek-ai/DeepSeek-R1-Distill-Llama-8B")
    sae_repo: str = os.getenv("SAE_REPO", "OpenMOSS-Team/Llama-Scope-R1-Distill")

    hook_layers: list[int] = field(
        default_factory=lambda: _int_list(
            os.getenv(
                "HOOK_LAYERS",
                "0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,"
                "16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31",
            )
        )
    )
    stream_top_k: int = int(os.getenv("STREAM_TOP_K", "20"))

    temperature: float = float(os.getenv("TEMPERATURE", "0.6"))
    top_p: float = float(os.getenv("TOP_P", "0.95"))
    seed: int = int(os.getenv("SEED", "42"))

    db_path: Path = Path(os.getenv("DB_PATH", "./data/probes.sqlite"))
    dtype: str = os.getenv("DTYPE", "float16")
    device: str = os.getenv("DEVICE", "mps")

    # Neuronpedia label lookup
    neuronpedia_api_base: str = os.getenv(
        "NEURONPEDIA_API_BASE", "https://www.neuronpedia.org/api"
    )
    neuronpedia_model_id: str = os.getenv(
        "NEURONPEDIA_MODEL_ID", "deepseek-r1-distill-llama-8b"
    )
    # Format: "{layer}-{NEURONPEDIA_SAE_SUFFIX}" — matches the slimpj-openr1
    # SAE family on Neuronpedia, which has labels populated for every layer.
    neuronpedia_sae_suffix: str = os.getenv(
        "NEURONPEDIA_SAE_SUFFIX", "llamascope-slimpj-openr1-res-32k"
    )

    # ----- Autorun + proposer -----
    # Seconds between probes when the autorun loop is active. Modest so
    # the live polygraph still feels live if you happen to be watching.
    autorun_interval_sec: float = float(os.getenv("AUTORUN_INTERVAL_SEC", "10"))

    # Once total queue depth (curated_unused + generated_unused) drops
    # below this threshold, autorun kicks the proposer subprocess.
    proposer_trigger_depth: int = int(os.getenv("PROPOSER_TRIGGER_DEPTH", "3"))

    # How many probes the proposer should produce per swap-in. The
    # subprocess may produce fewer (rejection of duplicates against the
    # curated set + already-used proposer set drops some).
    proposer_batch_size: int = int(os.getenv("PROPOSER_BATCH_SIZE", "20"))

    # The probe-proposer model. Different family from the runner so the
    # proposer doesn't bias toward its own thinking style.
    proposer_model: str = os.getenv("PROPOSER_MODEL", "Qwen/Qwen3-14B")

    # ----- Analyzer (journal report generation, frontier API) -----
    # Anthropic SDK reads ANTHROPIC_API_KEY from env directly.
    analyzer_model: str = os.getenv("ANALYZER_MODEL", "claude-opus-4-7")


settings = Settings()
