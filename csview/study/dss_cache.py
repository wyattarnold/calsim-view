"""
DSS pickle cache — reads all variables from a DSS file via pydsstools and
persists the result as a pickle file.  Subsequent builds can reload the pickle
instead of re-opening the DSS binary, which is **much** faster and removes
the pydsstools dependency for rebuild-only workflows.

Pickle layout (per DSS file)
-----------------------------
``<name>.dss.pkl`` — a dict with keys:

    {
        "source":    str,           # original DSS file path
        "cached_at": str,           # ISO timestamp
        "catalog":   {varname: [DssPathname, ...]},
        "series":    {varname: pd.Series},
    }

Usage
-----
    from csview.study.dss_cache import load_or_cache_dss

    df, catalog_index = load_or_cache_dss(dss_path, cache_dir)

The cache is invalidated when the DSS file's mtime changes.
"""

from __future__ import annotations

import logging
import pickle
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import pandas as pd

logger = logging.getLogger(__name__)


def _pickle_path(dss_path: Path, cache_dir: Path) -> Path:
    """Return the pickle cache path for a given DSS file."""
    return cache_dir / (dss_path.name + ".pkl")


def _is_cache_valid(dss_path: Path, pkl_path: Path) -> bool:
    """Return True if the pickle cache exists and is newer than the DSS file."""
    if not pkl_path.exists():
        return False
    try:
        return pkl_path.stat().st_mtime >= dss_path.stat().st_mtime
    except OSError:
        return False


def cache_dss_file(dss_path: Path, cache_dir: Path) -> Path:
    """Read every variable from *dss_path* via pydsstools and write a pickle cache.

    Returns the path to the written pickle file.
    """
    from csview.study.dss_reader import DssFile, DssPathname

    cache_dir.mkdir(parents=True, exist_ok=True)
    pkl_path = _pickle_path(dss_path, cache_dir)

    logger.info("Caching DSS file: %s → %s", dss_path.name, pkl_path.name)
    dss = DssFile(dss_path)
    dss.open()

    catalog_index = dss.catalog()
    all_vars = dss.variables()

    series_map: Dict[str, pd.Series] = {}
    for var in all_vars:
        try:
            series_map[var] = dss.read_timeseries(var)
        except Exception as exc:
            logger.debug("Skipping %s: %s", var, exc)

    dss.close()

    # Serialize DssPathname objects as plain dicts for portability
    catalog_ser = {
        var: [{"raw": p.raw, "a": p.a, "b": p.b, "c": p.c,
               "d": p.d, "e": p.e, "f": p.f} for p in paths]
        for var, paths in catalog_index.items()
    }

    payload = {
        "source": str(dss_path),
        "cached_at": datetime.utcnow().isoformat() + "Z",
        "catalog": catalog_ser,
        "series": series_map,
    }
    with open(pkl_path, "wb") as f:
        pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)

    logger.info("  Cached %d variables (%d with data) → %s",
                len(all_vars), len(series_map), pkl_path.name)
    return pkl_path


def load_cache(pkl_path: Path) -> dict:
    """Load a DSS pickle cache and reconstitute DssPathname objects."""
    from csview.study.dss_reader import DssPathname

    with open(pkl_path, "rb") as f:
        payload = pickle.load(f)  # noqa: S301

    # Reconstitute DssPathname frozen dataclasses
    catalog_reconstituted: Dict[str, List[DssPathname]] = {}
    for var, path_dicts in payload.get("catalog", {}).items():
        catalog_reconstituted[var] = [
            DssPathname(**d) for d in path_dicts
        ]
    payload["catalog"] = catalog_reconstituted
    return payload


def load_or_cache_dss(
    dss_path: Path,
    cache_dir: Path,
) -> Tuple[Dict[str, pd.Series], Dict[str, list]]:
    """Load DSS data, using pickle cache when available.

    If a valid cache exists (newer than the DSS file), loads from pickle.
    Otherwise reads the DSS via pydsstools and writes a new cache.

    Returns
    -------
    series_map : dict
        ``{varname: pd.Series}`` for every successfully read variable.
    catalog_index : dict
        ``{varname: [DssPathname, ...]}`` pathname index.
    """
    pkl_path = _pickle_path(dss_path, cache_dir)

    if _is_cache_valid(dss_path, pkl_path):
        logger.info("Loading DSS from cache: %s", pkl_path.name)
        payload = load_cache(pkl_path)
        return payload["series"], payload["catalog"]

    # Cache miss — read from DSS and create cache
    cache_dss_file(dss_path, cache_dir)
    payload = load_cache(pkl_path)
    return payload["series"], payload["catalog"]


def read_cached_variable(
    series_map: Dict[str, pd.Series],
    variable: str,
) -> Optional[pd.Series]:
    """Get a single variable from a cached series map (exact match)."""
    return series_map.get(variable)
