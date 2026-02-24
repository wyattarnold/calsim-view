"""
FastAPI application factory for the CalSim View app.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from csview.app.routers import network as network_router
from csview.app.routers import study as study_router
from csview.app.state import state as get_state_singleton

logger = logging.getLogger(__name__)

_STATIC_DIR = Path(__file__).parent / "static"


def create_app(
    network_dir: Optional[Path] = None,
    study_paths: Optional[List[Path]] = None,
    default_study: Optional[str] = None,
) -> FastAPI:
    """Create and configure the CalSim View FastAPI application.

    Parameters
    ----------
    network_dir:
        Directory containing pre-built ``network.geojson`` and ``network.json``.
        Build these once with::

            python -m csview.geo --geo-dir reference/geoschematic --out data/network/

    study_paths:
        List of compiled study directories (each containing ``results.parquet``
        and ``results_meta.json``). Study identity is read from the metadata.
    default_study:
        Name of the study to activate by default. If None, the first registered
        study is used.
    """

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = get_state_singleton()
        if network_dir is not None:
            state.load(
                network_dir=network_dir,
                study_paths=study_paths or [],
                default_study=default_study,
            )
        else:
            logger.warning(
                "No network_dir provided — app will start with an empty network. "
                "Pass --network-dir or call create_app(network_dir=...) to load data."
            )
        yield
        state.close()

    app = FastAPI(
        title="CalSim View",
        description="Interactive visualisation for CalSim 3 model results.",
        version="2026.02.23",
        lifespan=lifespan,
    )

    app.include_router(
        network_router.router, prefix="/api/network", tags=["Network"]
    )
    app.include_router(
        study_router.router, prefix="/api/study", tags=["Study"]
    )

    # Serve the built React frontend if present
    if _STATIC_DIR.exists():
        app.mount(
            "/",
            StaticFiles(directory=str(_STATIC_DIR), html=True),
            name="static",
        )
    else:
        logger.warning(
            "Static frontend not found at %s. "
            "Run `cd csview/app/frontend && npm run build` to build it.",
            _STATIC_DIR,
        )

    return app
