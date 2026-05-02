"""FastAPI factory. Loads model + SAEs once on startup; tears down cleanly on shutdown."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

import torch
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ..config import settings
from ..pipeline.model_loader import load_model
from ..pipeline.sae_runner import SAEManager
from ..storage import db
from .routes_probe import router as probe_router
from .routes_stream import router as stream_router
from .runs import RunRegistry

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s :: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db(settings.db_path)
    logger.info("loading model+SAEs (this takes a minute)...")

    dtype = {"float16": torch.float16, "float32": torch.float32, "bfloat16": torch.bfloat16}[
        settings.dtype
    ]

    bundle = await asyncio.to_thread(
        load_model,
        settings.model_name,
        device_str=settings.device,
        dtype=dtype,
    )
    saes = SAEManager(
        repo_id=settings.sae_repo,
        layer_indices=settings.hook_layers,
        d_model=bundle.hidden_dim,
        d_sae=65536,
        device=bundle.device,
        dtype=dtype,
    )
    await asyncio.to_thread(saes.load)

    app.state.bundle = bundle
    app.state.saes = saes
    app.state.registry = RunRegistry()

    logger.info(
        "ready: model layers=%d hidden=%d  SAE layers=%d",
        bundle.num_layers,
        bundle.hidden_dim,
        saes.num_loaded,
    )

    try:
        yield
    finally:
        logger.info("shutting down")


def create_app() -> FastAPI:
    app = FastAPI(
        title="Cells Interlinked",
        description="A Voight-Kampff test for language models",
        version="0.1.0",
        lifespan=lifespan,
    )
    # Local network: allow any LAN origin since this is a single-user offline tool.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^http://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|[a-z0-9-]+\.local)(:\d+)?$",
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    app.include_router(probe_router)
    app.include_router(stream_router)

    @app.get("/health")
    def health() -> dict:
        bundle = getattr(app.state, "bundle", None)
        saes = getattr(app.state, "saes", None)
        return {
            "status": "ok",
            "model_loaded": bundle is not None,
            "sae_layers_loaded": saes.num_loaded if saes is not None else 0,
            "device": str(bundle.device) if bundle else None,
            "hook_layers": settings.hook_layers,
        }

    return app
