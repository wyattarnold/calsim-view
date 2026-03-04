"""
StudyStore — memory-efficient access to pre-built Parquet results.

Individual columns are read on demand from the Parquet file rather than
loading the full DataFrame into memory.  This reduces per-study RAM from
~60 MB to near-zero at a latency cost of ~1-2 ms per column read (SSD).

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

    A lightweight ``pyarrow.ParquetFile`` handle is held open so that
    per-column reads avoid re-reading Parquet footer metadata.  Actual
    column data is read on demand — either one-at-a-time via
    ``get_series()`` or in bulk via ``get_series_batch()`` /
    ``get_multi_feature_series()``.
    """

    name: str
    study_dir: Path
    _meta: Optional[Dict[str, Any]] = field(default=None, repr=False)
    _upper_to_col: Optional[Dict[str, str]] = field(default=None, repr=False)
    _pf: Optional[Any] = field(default=None, repr=False)  # cached pq.ParquetFile
    _cached_index: Optional[Any] = field(default=None, repr=False)  # DatetimeIndex

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
    # Schema / index loading (lightweight — no data read)
    # ------------------------------------------------------------------

    def _ensure_index(self) -> None:
        """Open a cached ParquetFile handle and build the column index."""
        if self._upper_to_col is not None:
            return
        import pyarrow.parquet as pq

        self._pf = pq.ParquetFile(str(self.parquet_path))
        cols = [n for n in self._pf.schema_arrow.names
                if not n.startswith("__")]
        self._upper_to_col = {c.upper(): c for c in cols}

        # Cache the DatetimeIndex by reading one column with pd.read_parquet
        # which correctly restores the pandas index from Parquet metadata.
        if cols:
            df_one = pd.read_parquet(self.parquet_path, columns=[cols[0]])
            self._cached_index = df_one.index
        else:
            self._cached_index = pd.RangeIndex(0)

        logger.info(
            "Indexed %d variables from %s", len(cols), self.parquet_path
        )

    # Keep legacy name as an alias so callers (e.g. state.py eager-load)
    # continue to work without loading the full DataFrame into memory.
    _ensure_loaded = _ensure_index

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
        """List all variable names available in this study store."""
        self._ensure_index()
        return list(self._upper_to_col.values())  # type: ignore[union-attr]

    def has_variable(self, prmname: str) -> bool:
        self._ensure_index()
        return prmname.upper() in self._upper_to_col  # type: ignore[arg-type]

    def get_series(self, prmname: str) -> Optional[pd.Series]:
        """Return the monthly time series for *prmname*, or None if not found.

        Uses the cached ParquetFile handle to avoid re-reading footer
        metadata.  Downcast to float32 to halve memory.
        """
        self._ensure_index()
        col = self._upper_to_col.get(prmname.upper())  # type: ignore[union-attr]
        if col is None:
            return None
        table = self._pf.read(columns=[col])  # type: ignore[union-attr]
        df = table.to_pandas()
        df.index = self._cached_index
        s = df.iloc[:, 0].dropna()
        if s.dtype == "float64":
            s = s.astype("float32")
        return s

    def get_series_batch(self, prmnames: List[str]) -> Dict[str, pd.Series]:
        """Read multiple columns in one Parquet I/O pass.

        Returns a dict keyed by the input *prmnames* (only those that exist
        in the Parquet).  All float64 data is downcast to float32.
        """
        self._ensure_index()
        to_read: Dict[str, str] = {}  # input name → actual column
        for name in prmnames:
            col = self._upper_to_col.get(name.upper())  # type: ignore[union-attr]
            if col is not None:
                to_read[name] = col
        if not to_read:
            return {}
        unique_cols = list(dict.fromkeys(to_read.values()))  # dedupe, keep order
        table = self._pf.read(columns=unique_cols)  # type: ignore[union-attr]
        df = table.to_pandas()
        df.index = self._cached_index
        float_cols = df.select_dtypes("float64").columns
        if len(float_cols):
            df[float_cols] = df[float_cols].astype("float32")
        result: Dict[str, pd.Series] = {}
        for name, col in to_read.items():
            s = df[col].dropna()
            if not s.empty:
                result[name] = s
        return result

    def get_feature_series(self, feature_id: str) -> Dict[str, pd.Series]:
        """Return all series for a GeoSchematic *feature_id*.

        For arc features the feature_id IS the DSS variable name, so at most
        one series is returned.  For node features multiple DSS variables may
        map to the same node; this method returns all of them.

        All candidates are collected first and read in a single Parquet I/O
        pass via :meth:`get_series_batch`.
        """
        meta = self._ensure_meta()
        node_vars = meta.get("node_dss_variables", {}).get(feature_id.upper(), [])
        arc_vars = meta.get("arc_dss_variables", {}).get(feature_id.upper(), [])

        # One batch read for all candidates
        batch = self.get_series_batch([feature_id] + node_vars + arc_vars)

        result: Dict[str, pd.Series] = {}
        if feature_id in batch:
            result[feature_id] = batch[feature_id]
        # Node variables (only when no direct match)
        if not result:
            for var in node_vars:
                if var in batch:
                    result[var] = batch[var]
        # Arc-level DSS variable overrides (always append)
        for var in arc_vars:
            if var not in result and var in batch:
                result[var] = batch[var]
        return result

    def get_multi_feature_series(
        self, feature_ids: List[str],
    ) -> Dict[str, Dict[str, pd.Series]]:
        """Batch :meth:`get_feature_series` for many feature IDs at once.

        Returns ``{feature_id: {var: Series, ...}, ...}`` with a single
        underlying Parquet I/O pass.
        """
        meta = self._ensure_meta()
        all_candidates: List[str] = []
        for fid in feature_ids:
            all_candidates.append(fid)
            all_candidates.extend(
                meta.get("node_dss_variables", {}).get(fid.upper(), []))
            all_candidates.extend(
                meta.get("arc_dss_variables", {}).get(fid.upper(), []))

        batch = self.get_series_batch(all_candidates)

        result: Dict[str, Dict[str, pd.Series]] = {}
        for fid in feature_ids:
            node_vars = meta.get("node_dss_variables", {}).get(fid.upper(), [])
            arc_vars = meta.get("arc_dss_variables", {}).get(fid.upper(), [])
            per_fid: Dict[str, pd.Series] = {}
            if fid in batch:
                per_fid[fid] = batch[fid]
            if not per_fid:
                for var in node_vars:
                    if var in batch:
                        per_fid[var] = batch[var]
            for var in arc_vars:
                if var not in per_fid and var in batch:
                    per_fid[var] = batch[var]
            if per_fid:
                result[fid] = per_fid
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
        available so the full Parquet is *not* loaded into memory.
        Falls back to reading a single Parquet column for the index range.
        """
        meta = self._ensure_meta()
        dr = meta.get("date_range", {})
        start = dr.get("start") if isinstance(dr, dict) else None
        end = dr.get("end") if isinstance(dr, dict) else None
        if start and end:
            return start, end
        # Fallback: read one column via cached PF to derive index range
        self._ensure_index()
        if not self._upper_to_col:
            return None, None
        any_col = next(iter(self._upper_to_col.values()))
        table = self._pf.read(columns=[any_col])  # type: ignore[union-attr]
        df = table.to_pandas()
        df.index = self._cached_index
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
            # Downcast float64 → float32 to halve memory (~5 MB → ~2.5 MB)
            float_cols = self._df.select_dtypes("float64").columns
            if len(float_cols):
                self._df[float_cols] = self._df[float_cols].astype("float32")
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
