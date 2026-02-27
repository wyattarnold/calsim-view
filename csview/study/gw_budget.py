"""
Groundwater budget builder — reads CVGroundwaterBudget.dss and maps the
per-SR (aggregated CalSim region) data back to Water Budget Areas (WBAs).

Pipeline
--------
1. Parse CVElementsToCalsimRegions DAT file → SR → WBA mapping
2. Open CVGroundwaterBudget.dss via pydsstools (or pickle cache)
3. Read each SR × C-part combination as a separate time series
4. Aggregate (sum) SR series into WBA-level series
5. Write ``gw_budget.parquet`` + ``gw_budget_meta.json``

DSS structure
-------------
CVGroundwaterBudget.dss contains 66 variables named SR1–SR66.  Each SR
has 11 C-parts (budget components):

    CHANGE_STORAGE, FLOW_BC, GHB, HEAD_BC, LATERAL_FLOW,
    NET_DEEP_PERC, PUMPING, SMALL_WSHED, STRM_GW_INT,
    SUBSIDENCE, TILE_DRAIN

The SR numbers map to CalSim aggregated groundwater regions defined in
``CVElementsToCalsimRegions_<date>.dat``.  That file also defines a
crosswalk from regions to Water Budget Areas (WBAs), including exterior
element regions (EA) that belong to the same WBA.

Parquet layout
--------------
Wide DataFrame:  rows = monthly DatetimeIndex,
                 columns = ``"{WBA_ID}__{C_PART}"``
                 e.g.  ``"02__PUMPING"``, ``"DETAW__NET_DEEP_PERC"``
"""

from __future__ import annotations

import json
import logging
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import pandas as pd

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Crosswalk parser
# ---------------------------------------------------------------------------

def parse_crosswalk(crosswalk_path: Path) -> Dict[str, str]:
    """Parse the CVElementsToCalsimRegions DAT file.

    Returns
    -------
    dict
        ``{SR_name: wba_id}`` — e.g. ``{"SR1": "02", "SR50": "02", ...}``

        Exterior-area SRs (``indxEA_*``) are mapped to the same WBA as
        their parent.  Tulare GWR regions (``indxGWR*``) and ``indxEA_NBAY``
        (North Bay exterior, no matching WBA polygon) are included with
        synthetic WBA IDs like ``"GWR15"`` / ``"NBAY"`` so their data is
        still available, though no polygon exists for them in the water
        budget areas GeoJSON.
    """
    text = crosswalk_path.read_text(encoding="utf-8", errors="replace")
    # Match lines like:  C	define	indxWBA_2	{value	1	}	Sacramento
    pattern = re.compile(
        r'C\s+define\s+(indx\w+)\s+\{value\s+(\d+)\s*\}',
        re.IGNORECASE,
    )
    sr_to_wba: Dict[str, str] = {}
    for m in pattern.finditer(text):
        indx_name = m.group(1)      # e.g. "indxWBA_2", "indxEA_02", "indxGWR15"
        region_num = int(m.group(2)) # e.g. 1, 50, 43
        sr_name = f"SR{region_num}"
        wba_id = _normalize_wba_id(indx_name)
        sr_to_wba[sr_name] = wba_id
        logger.debug("  %s → %s (region %d)", indx_name, wba_id, region_num)

    logger.info("Parsed crosswalk: %d SR → WBA entries", len(sr_to_wba))
    return sr_to_wba


# Known WBA IDs in water_budget_areas.geojson (for validation)
_WBA_IDS = {
    "02", "03", "04", "05", "06", "07N", "07S", "08N", "08S", "09",
    "10", "11", "12", "13", "14", "15N", "15S", "16", "17N", "17S",
    "18", "19", "20", "21", "22", "23", "24", "25", "26N", "26S",
    "50", "60N", "60S", "61", "62", "63", "64", "71", "72", "73",
    "90", "DETAW",
}


def _normalize_wba_id(indx_name: str) -> str:
    """Convert a crosswalk index name to a WBA identifier.

    Examples
    --------
    >>> _normalize_wba_id("indxWBA_2")
    '02'
    >>> _normalize_wba_id("indxWBA_7N")
    '07N'
    >>> _normalize_wba_id("indxWBA_15N")
    '15N'
    >>> _normalize_wba_id("indxDETAW")
    'DETAW'
    >>> _normalize_wba_id("indxEA_02")
    '02'
    >>> _normalize_wba_id("indxEA_DETAW")
    'DETAW'
    >>> _normalize_wba_id("indxGWR15")
    'GWR15'
    >>> _normalize_wba_id("indxEA_NBAY")
    'NBAY'
    """
    name = indx_name.strip()

    # Exterior areas: indxEA_XX → map to the same WBA as the main area.
    if name.upper().startswith("INDXEA_"):
        suffix = name[7:]  # after "indxEA_"
        # EA_DETAW → DETAW, EA_NBAY → NBAY, EA_02 → 02
        return _pad_wba_num(suffix)

    # Main WBAs: indxWBA_XX
    if name.upper().startswith("INDXWBA_"):
        suffix = name[8:]  # after "indxWBA_"
        return _pad_wba_num(suffix)

    # Delta: indxDETAW
    if name.upper() == "INDXDETAW":
        return "DETAW"

    # Tulare GWR: indxGWR15 → GWR15
    m = re.match(r'indxGWR(\d+)', name, re.IGNORECASE)
    if m:
        return f"GWR{m.group(1)}"

    # Fallback
    return name.replace("indx", "").replace("indx", "")


def _pad_wba_num(raw: str) -> str:
    """Zero-pad single-digit WBA numbers to match GeoJSON conventions.

    ``"2"`` → ``"02"``, ``"7N"`` → ``"07N"``, ``"15N"`` → ``"15N"``,
    ``"DETAW"`` → ``"DETAW"``.
    """
    m = re.match(r'^(\d+)(.*)', raw)
    if m:
        num, suffix = m.group(1), m.group(2)
        if len(num) == 1:
            return f"0{num}{suffix}"
        return f"{num}{suffix}"
    return raw


# ---------------------------------------------------------------------------
# DSS reader — per-C-part extraction
# ---------------------------------------------------------------------------

def read_gw_budget_by_cpart(
    dss_path: Path,
    cache_dir: Optional[Path] = None,
) -> Dict[Tuple[str, str], pd.Series]:
    """Read CVGroundwaterBudget.dss, separating each SR × C-part.

    Parameters
    ----------
    dss_path : Path
        Path to CVGroundwaterBudget.dss.
    cache_dir : Path, optional
        If a GW-budget-specific pickle cache exists here, use it.
        Otherwise read from the DSS file via pydsstools and cache.

    Returns
    -------
    dict
        ``{("SR1", "PUMPING"): pd.Series, ...}`` for every SR × C-part.
    """
    pkl_name = dss_path.name + ".gwbudget.pkl"
    pkl_path = cache_dir / pkl_name if cache_dir else None

    if pkl_path and pkl_path.exists():
        try:
            import pickle
            payload = pickle.load(open(pkl_path, "rb"))  # noqa: S301
            logger.info("Loaded GW budget from cache: %s", pkl_path.name)
            return payload["series"]
        except Exception as exc:
            logger.warning("Failed to load GW budget cache: %s", exc)

    # --- Read from DSS file via pydsstools ---
    from csview.study.dss_reader import DssFile, DssPathname

    logger.info("Reading GW budget DSS: %s", dss_path.name)
    dss = DssFile(dss_path)
    dss.open()
    catalog = dss.catalog()

    result: Dict[Tuple[str, str], pd.Series] = {}

    for var_name, pathnames in catalog.items():
        # Group pathnames by C-part
        by_cpart: Dict[str, List] = defaultdict(list)
        for p in pathnames:
            if p.e.upper() == "1MON":
                by_cpart[p.c].append(p)

        for c_part, cpaths in by_cpart.items():
            segments = []
            captured_units = ""
            for p in cpaths:
                try:
                    ts = dss._fid.read_ts(p.raw)
                    times = ts.pytimes
                    values = list(ts.values)
                    if not times:
                        continue
                    if not captured_units and ts.units:
                        captured_units = str(ts.units).strip()
                    seg = pd.Series(
                        data=values,
                        index=pd.DatetimeIndex(times),
                        dtype=float,
                    )
                    segments.append(seg)
                except Exception as exc:
                    logger.debug("Error reading %s: %s", p.raw, exc)

            if not segments:
                continue

            series = pd.concat(segments).sort_index()
            series = series[~series.index.duplicated(keep="first")]
            series.index = series.index + pd.offsets.MonthEnd(0)
            series.replace(-901.0, float("nan"), inplace=True)
            series.dropna(inplace=True)
            series.name = f"{var_name}__{c_part}"
            series.index.name = "date"
            series.attrs["units"] = captured_units

            result[(var_name, c_part)] = series

    dss.close()
    logger.info("Read %d SR × C-part time series from %s", len(result), dss_path.name)

    # Cache for next time
    if pkl_path:
        import pickle
        cache_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            "source": str(dss_path),
            "cached_at": datetime.utcnow().isoformat() + "Z",
            "series": result,
        }
        with open(pkl_path, "wb") as f:
            pickle.dump(payload, f, protocol=4)
        logger.info("Cached GW budget: %s", pkl_path.name)

    return result


# ---------------------------------------------------------------------------
# WBA aggregation and parquet builder
# ---------------------------------------------------------------------------

# Human-readable labels for IWFM GW budget C-parts
CPART_LABELS = {
    "PUMPING":         "Pumping",
    "NET_DEEP_PERC":   "Net Deep Percolation",
    "STRM_GW_INT":     "Stream-GW Interaction",
    "LATERAL_FLOW":    "Lateral Flow",
    "CHANGE_STORAGE":  "Change in Storage",
    "SMALL_WSHED":     "Small Watersheds",
    "SUBSIDENCE":      "Subsidence",
    "TILE_DRAIN":      "Tile Drain",
    "FLOW_BC":         "Flow Boundary",
    "HEAD_BC":         "Head Boundary",
    "GHB":             "General Head Boundary",
}


def build_gw_budget(
    dss_path: Path,
    crosswalk_path: Path,
    out_dir: Path,
    *,
    cache_dir: Optional[Path] = None,
    sim_start: Optional[str] = None,
    sim_end: Optional[str] = None,
) -> None:
    """Build ``gw_budget.parquet`` + ``gw_budget_meta.json``.

    Parameters
    ----------
    dss_path : Path
        CVGroundwaterBudget.dss
    crosswalk_path : Path
        CVElementsToCalsimRegions_<date>.dat
    out_dir : Path
        Output directory (same as study output, e.g. ``data/study/study_a/``).
    cache_dir : Path, optional
        Directory for GW budget pickle cache.
    sim_start, sim_end : str, optional
        Simulation period clip (YYYY-MM).
    """
    # 1. Parse crosswalk
    sr_to_wba = parse_crosswalk(crosswalk_path)

    # 2. Read per-SR per-C-part data
    sr_cpart_series = read_gw_budget_by_cpart(dss_path, cache_dir=cache_dir)

    # 3. Build WBA→{C_part: [Series, ...]} for aggregation
    wba_cpart_lists: Dict[str, Dict[str, List[pd.Series]]] = defaultdict(
        lambda: defaultdict(list)
    )
    unmapped_srs: Set[str] = set()

    for (sr_name, c_part), series in sr_cpart_series.items():
        wba_id = sr_to_wba.get(sr_name)
        if wba_id is None:
            unmapped_srs.add(sr_name)
            continue
        wba_cpart_lists[wba_id][c_part].append(series)

    if unmapped_srs:
        logger.warning("Unmapped SRs (no crosswalk entry): %s", sorted(unmapped_srs))

    # 4. Aggregate: sum all SR series that map to the same WBA × C-part
    frames: Dict[str, pd.Series] = {}
    wba_ids_with_data: Set[str] = set()
    c_parts_seen: Set[str] = set()

    for wba_id, cpart_dict in sorted(wba_cpart_lists.items()):
        for c_part, series_list in sorted(cpart_dict.items()):
            if len(series_list) == 1:
                agg = series_list[0]
            else:
                combined = pd.concat(series_list, axis=1)
                agg = combined.sum(axis=1)
            col_name = f"{wba_id}__{c_part}"
            agg.name = col_name
            frames[col_name] = agg
            wba_ids_with_data.add(wba_id)
            c_parts_seen.add(c_part)

    if not frames:
        logger.error("No GW budget data produced; aborting")
        return

    df = pd.concat(frames, axis=1)
    df.sort_index(inplace=True)

    # 5. Clip to simulation period
    if sim_start or sim_end:
        before = len(df)
        df = df.loc[sim_start:sim_end]
        logger.info("Clipped GW budget: %d → %d rows", before, len(df))

    # 6. Detect units from first series
    sample_key = next(iter(sr_cpart_series))
    sample_series = sr_cpart_series[sample_key]
    units = sample_series.attrs.get("units", "")

    # 7. Write parquet
    out_dir.mkdir(parents=True, exist_ok=True)
    parquet_path = out_dir / "gw_budget.parquet"
    df.to_parquet(parquet_path)
    logger.info(
        "Wrote %s: %d WBAs × %d C-parts = %d columns, %d rows",
        parquet_path, len(wba_ids_with_data), len(c_parts_seen),
        len(df.columns), len(df),
    )

    # 8. Write metadata
    # Identify which WBAs have matching GeoJSON polygons vs. synthetic-only
    matched_wbas = sorted(wba_ids_with_data & _WBA_IDS)
    unmatched_wbas = sorted(wba_ids_with_data - _WBA_IDS)

    meta = {
        "built_at": datetime.utcnow().isoformat() + "Z",
        "dss_source": str(dss_path),
        "crosswalk_source": str(crosswalk_path),
        "units": units or "AF",
        "c_parts": sorted(c_parts_seen),
        "c_part_labels": {k: v for k, v in CPART_LABELS.items() if k in c_parts_seen},
        "wba_ids": sorted(wba_ids_with_data),
        "wba_ids_with_polygon": matched_wbas,
        "wba_ids_without_polygon": unmatched_wbas,
        "sr_to_wba": sr_to_wba,
        "column_format": "{wba_id}__{c_part}",
        "date_range": {
            "start": str(df.index.min().date()) if not df.empty else None,
            "end": str(df.index.max().date()) if not df.empty else None,
        },
    }
    meta_path = out_dir / "gw_budget_meta.json"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    logger.info("Wrote %s", meta_path)
