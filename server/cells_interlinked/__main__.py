"""Boot the FastAPI app via uvicorn. Run with: `uv run python -m cells_interlinked`."""

from __future__ import annotations

import uvicorn

from .config import settings


def main() -> None:
    uvicorn.run(
        "cells_interlinked.api.app:create_app",
        factory=True,
        host=settings.server_host,
        port=settings.server_port,
        log_level="info",
        reload=False,
    )


if __name__ == "__main__":
    main()
