"""
Application state — loads the GeoSchematic network and pre-built Parquet
study stores at startup.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Dict, Generator, List, Optional

from csview.geo.loader import load_from_catalog
from csview.geo.models import GeoNetwork
from csview.study.store import StudyStore, GwBudgetStore

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# AppState singleton
# ---------------------------------------------------------------------------

class AppState:
    """Global application state (one instance shared across all requests)."""

    def __init__(self) -> None:
        self.network: Optional[GeoNetwork] = None
        self.studies: Dict[str, StudyStore] = {}
        self.gw_budgets: Dict[str, GwBudgetStore] = {}
        self.active_study: Optional[str] = None
        self._loaded = False

    # ------------------------------------------------------------------
    # Loaders
    # ------------------------------------------------------------------

    def load(
        self,
        network_dir: Path,
        study_paths: List[Path],
        default_study: Optional[str] = None,
    ) -> None:
        """Load the GeoNetwork and register pre-built StudyStore objects."""
        network_dir = Path(network_dir)

        logger.info("Loading GeoNetwork from %s", network_dir)
        self.network = load_from_catalog(network_dir)
        logger.info(
            "  Network: %d nodes, %d arcs",
            len(self.network.nodes),
            len(self.network.arcs),
        )

        for sp in study_paths:
            sp = Path(sp)
            try:
                store = StudyStore.from_dir(sp)
                self.studies[store.name] = store
                logger.info("Registered study: %s", store.name)
                # Also check for GW budget
                gw = GwBudgetStore.from_dir(sp)
                if gw is not None:
                    self.gw_budgets[store.name] = gw
                    logger.info("  GW budget available for %s", store.name)
            except FileNotFoundError as exc:
                logger.warning("Skipping study %s: %s", sp, exc)

        if self.studies:
            self.active_study = (
                default_study
                if default_study and default_study in self.studies
                else next(iter(self.studies))
            )
            logger.info("Active study: %s", self.active_study)
            # Eagerly load only the active study so the first user request
            # doesn't block on Parquet I/O.  Non-active studies load lazily
            # on first access (typically fast enough within request timeouts).
            active_store = self.studies[self.active_study]
            active_store._ensure_loaded()
            if self.active_study in self.gw_budgets:
                self.gw_budgets[self.active_study]._ensure_loaded()

        self._loaded = True

    # ------------------------------------------------------------------
    # Study helpers
    # ------------------------------------------------------------------

    def get_study(self, name: Optional[str]) -> Optional[StudyStore]:
        if name is None:
            return self.studies.get(self.active_study) if self.active_study else None
        return self.studies.get(name)

    def get_gw_budget(self, name: Optional[str]) -> Optional[GwBudgetStore]:
        """Return the GwBudgetStore for the given study name, or active study."""
        key = name if name else self.active_study
        return self.gw_budgets.get(key) if key else None

    def set_active_study(self, name: str) -> None:
        if name not in self.studies:
            raise KeyError(f"Study '{name}' not registered")
        self.active_study = name

    def iter_studies(self) -> Generator[StudyStore, None, None]:
        yield from self.studies.values()

    def close(self) -> None:
        """Release any held resources (Parquet frames, etc.)."""
        for store in self.studies.values():
            store._df = None
            store._meta = None


# ---------------------------------------------------------------------------
# FastAPI dependency
# ---------------------------------------------------------------------------

_state = AppState()


def get_state() -> AppState:
    """FastAPI dependency — injects the singleton :class:`AppState`."""
    return _state


def state() -> AppState:
    """Direct access to the singleton (for use in lifespan context)."""
    return _state
