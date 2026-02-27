"""
StudyStore — fast in-memory access to pre-built Parquet results.

File layout per compiled study directory
-----------------------------------------
data/study/<slug>/
    results.parquet       — wide-format DataFrame: rows=dates, cols=variables
    results_meta.json     — {study, built_at, dss_source,
                              variables: {prmname: {units, kind, node_type, c_part}}}

``study`` in results_meta.json is the logical study name shown in the app;
the directory slug (e.g. ``study_a``) is an opaque identifier.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

logger = logging.getLogger(__name__)

PARQUET_FILE = "results.parquet"
META_FILE = "results_meta.json"


@dataclass
class StudyStore:
    """Pre-built results for one CalSim study (backed by a Parquet file).

    The DataFrame is loaded lazily on first access and cached in memory.
    All per-variable queries are O(1) column lookups on the in-memory frame.
    """

    name: str
    study_dir: Path
    _df: Optional[pd.DataFrame] = field(default=None, repr=False)
    _meta: Optional[Dict[str, Any]] = field(default=None, repr=False)
    _upper_to_col: Optional[Dict[str, str]] = field(default=None, repr=False)

    # ------------------------------------------------------------------
    # Construction helpers
    # ------------------------------------------------------------------

    @classmethod
    def from_dir(cls, study_dir: Path) -> "StudyStore":
        """Load a StudyStore from a compiled study directory.

        The directory must contain ``results.parquet``.  The study name is
        taken from ``results_meta.json`` (``study`` field) when available,
        falling back to the directory name.
        """
        study_dir = Path(study_dir)
        parquet = study_dir / PARQUET_FILE
        if not parquet.exists():
            raise FileNotFoundError(
                f"results.parquet not found in {study_dir}. "
                "Run: python -m csview.study --source <raw-dir> --out <this-dir>"
            )
        # Prefer the study name recorded in metadata over the directory name
        name = study_dir.name
        meta_path = study_dir / META_FILE
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                name = meta.get("study") or name
            except Exception:
                pass
        return cls(name=name, study_dir=study_dir)

    @property
    def parquet_path(self) -> Path:
        return self.study_dir / PARQUET_FILE

    @property
    def meta_path(self) -> Path:
        return self.study_dir / META_FILE

    # ------------------------------------------------------------------
    # Lazy loading
    # ------------------------------------------------------------------

    def _ensure_loaded(self) -> pd.DataFrame:
        if self._df is None:
            logger.info("Loading results from %s", self.parquet_path)
            self._df = pd.read_parquet(self.parquet_path)
            # Timestamps in the Parquet are already end-of-month for the
            # correct period (snapped by the DSS reader at build time).
            # No additional shift is needed.
            # Build case-insensitive lookup: UPPER → actual column name
            self._upper_to_col = {c.upper(): c for c in self._df.columns}
            logger.info(
                "  Loaded: %d variables x %d time steps",
                len(self._df.columns),
                len(self._df),
            )
        return self._df

    def _ensure_meta(self) -> Dict[str, Any]:
        if self._meta is None:
            if self.meta_path.exists():
                self._meta = json.loads(self.meta_path.read_text(encoding="utf-8"))
            else:
                self._meta = {}
        return self._meta

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def variables(self) -> List[str]:
        """List all variable names available in this study store.

        Uses pyarrow schema read so the Parquet file doesn't need to be fully
        loaded into memory just to list columns.
        """
        if self._df is not None:
            return list(self._df.columns)
        try:
            import pyarrow.parquet as pq
            return pq.read_schema(str(self.parquet_path)).names
        except Exception:
            return list(self._ensure_loaded().columns)

    def has_variable(self, prmname: str) -> bool:
        self._ensure_loaded()
        return prmname.upper() in self._upper_to_col  # type: ignore[arg-type]

    def get_series(self, prmname: str) -> Optional[pd.Series]:
        """Return the monthly time series for *prmname*, or None if not found.

        The series has a DatetimeIndex and NaN values already dropped.
        Uses a cached uppercase→column map for O(1) case-insensitive lookup.
        """
        df = self._ensure_loaded()
        col = self._upper_to_col.get(prmname.upper())  # type: ignore[union-attr]
        if col is None:
            return None
        return df[col].dropna()

    def get_feature_series(self, feature_id: str) -> Dict[str, pd.Series]:
        """Return all series for a GeoSchematic *feature_id*.

        For arc features the feature_id IS the DSS variable name, so at most
        one series is returned.  For node features multiple DSS variables may
        map to the same node; this method returns all of them.

        Returns a dict keyed by variable name.
        """
        result: Dict[str, pd.Series] = {}
        meta = self._ensure_meta()
        # Try direct match (arc features: arc_id == DSS variable name)
        s = self.get_series(feature_id)
        if s is not None:
            result[feature_id] = s
        # For node features without a direct match, look up node_dss_variables
        if not result:
            node_vars = meta.get("node_dss_variables", {}).get(feature_id.upper(), [])
            for var in node_vars:
                s = self.get_series(var)
                if s is not None:
                    result[var] = s
        # For arc features with override DSS variable mappings, append them
        # alongside any direct match (allows split-flow arcs like C_SAC000)
        arc_vars = meta.get("arc_dss_variables", {}).get(feature_id.upper(), [])
        for var in arc_vars:
            if var not in result:
                s = self.get_series(var)
                if s is not None:
                    result[var] = s
        return result

    def get_variable_meta(self, prmname: str) -> Dict[str, Any]:
        """Return metadata dict for *prmname* (units, kind, c_part, node_type)."""
        meta = self._ensure_meta()
        variables_meta = meta.get("variables", {})
        return variables_meta.get(prmname, variables_meta.get(prmname.upper(), {}))

    @property
    def date_range(self):
        """Return (start_date, end_date) as ISO-format strings, or (None, None).

        Reads ``date_start``/``date_end`` from ``results_meta.json`` when
        available so the full Parquet is *not* loaded just to list studies.
        Falls back to the Parquet index only if the metadata fields are absent.
        """
        meta = self._ensure_meta()
        dr = meta.get("date_range", {})
        start = dr.get("start") if isinstance(dr, dict) else None
        end = dr.get("end") if isinstance(dr, dict) else None
        if start and end:
            return start, end
        # Fallback: derive from Parquet index (triggers full load)
        df = self._ensure_loaded()
        if df.empty:
            return None, None
        return str(df.index.min().date()), str(df.index.max().date())


# ---------------------------------------------------------------------------
# GW Budget Store — per-WBA groundwater budget time series
# ---------------------------------------------------------------------------

GW_BUDGET_PARQUET = "gw_budget.parquet"
GW_BUDGET_META = "gw_budget_meta.json"


@dataclass
class GwBudgetStore:
    """Pre-built groundwater budget results aggregated by Water Budget Area.

    Backed by ``gw_budget.parquet`` with columns like ``"02__PUMPING"``.
    Loaded lazily on first access.
    """

    study_dir: Path
    _df: Optional[pd.DataFrame] = field(default=None, repr=False)
    _meta: Optional[Dict[str, Any]] = field(default=None, repr=False)

    @classmethod
    def from_dir(cls, study_dir: Path) -> Optional["GwBudgetStore"]:
        """Return a GwBudgetStore if gw_budget.parquet exists, else None."""
        study_dir = Path(study_dir)
        if not (study_dir / GW_BUDGET_PARQUET).exists():
            return None
        return cls(study_dir=study_dir)

    @property
    def available(self) -> bool:
        return (self.study_dir / GW_BUDGET_PARQUET).exists()

    def _ensure_loaded(self) -> pd.DataFrame:
        if self._df is None:
            path = self.study_dir / GW_BUDGET_PARQUET
            logger.info("Loading GW budget from %s", path)
            self._df = pd.read_parquet(path)
            logger.info(
                "  GW budget: %d columns × %d rows",
                len(self._df.columns), len(self._df),
            )
        return self._df

    def _ensure_meta(self) -> Dict[str, Any]:
        if self._meta is None:
            meta_path = self.study_dir / GW_BUDGET_META
            if meta_path.exists():
                self._meta = json.loads(meta_path.read_text(encoding="utf-8"))
            else:
                self._meta = {}
        return self._meta

    @property
    def wba_ids(self) -> List[str]:
        """All WBA IDs that have budget data."""
        meta = self._ensure_meta()
        return meta.get("wba_ids", [])

    @property
    def wba_ids_with_polygon(self) -> List[str]:
        """WBA IDs that have matching GeoJSON polygons."""
        meta = self._ensure_meta()
        return meta.get("wba_ids_with_polygon", [])

    @property
    def c_parts(self) -> List[str]:
        """Available C-part (budget component) names."""
        meta = self._ensure_meta()
        return meta.get("c_parts", [])

    @property
    def c_part_labels(self) -> Dict[str, str]:
        """Human-readable labels for C-parts."""
        meta = self._ensure_meta()
        return meta.get("c_part_labels", {})

    @property
    def units(self) -> str:
        meta = self._ensure_meta()
        return meta.get("units", "")

    def get_wba_budget(self, wba_id: str) -> Dict[str, pd.Series]:
        """Return all budget component series for *wba_id*.

        Returns
        -------
        dict
            ``{"PUMPING": pd.Series, "NET_DEEP_PERC": pd.Series, ...}``
        """
        df = self._ensure_loaded()
        prefix = f"{wba_id}__"
        result: Dict[str, pd.Series] = {}
        for col in df.columns:
            if col.startswith(prefix):
                c_part = col[len(prefix):]
                s = df[col].dropna()
                if not s.empty:
                    result[c_part] = s
        return result

    def has_wba(self, wba_id: str) -> bool:
        """Return True if budget data exists for *wba_id*."""
        return wba_id in self.wba_ids
