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

    model_name: str = os.getenv("MODEL_NAME", "Qwen/Qwen3-8B")
    sae_repo: str = os.getenv("SAE_REPO", "Qwen/SAE-Res-Qwen3-8B-Base-W64K-L0_50")

    hook_layers: list[int] = field(
        default_factory=lambda: _int_list(
            os.getenv("HOOK_LAYERS", "2,6,10,14,16,18,20,22,24,26,28,30,34")
        )
    )
    stream_top_k: int = int(os.getenv("STREAM_TOP_K", "20"))

    temperature: float = float(os.getenv("TEMPERATURE", "0.7"))
    top_p: float = float(os.getenv("TOP_P", "0.8"))
    seed: int = int(os.getenv("SEED", "42"))

    db_path: Path = Path(os.getenv("DB_PATH", "./data/probes.sqlite"))
    dtype: str = os.getenv("DTYPE", "float16")
    device: str = os.getenv("DEVICE", "mps")


settings = Settings()
