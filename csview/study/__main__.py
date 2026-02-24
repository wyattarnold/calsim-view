"""
CLI builder — reads DSS and writes results.parquet + results_meta.json.

Usage
-----
    python -m csview.study \\
        --source  reference/calsim-studies/study_a \\
        --catalog data/network/catalog.json \\
        --out     data/study/study_a/

``--source`` is the raw CalSim study directory (contains DSS/ and Run/).
``--out``    is where the compiled artifacts are written (results.parquet,
             results_meta.json). This directory is tracked in git.

The builder:
  1. Loads catalog.json to get all known arc_ids and cs3_ids.
  2. Opens the study DSS output file from <source>/DSS/output/.
  3. Reads every DSS variable whose C-part or B-part matches a GeoSchematic
     feature, collecting them into a wide Pandas DataFrame.
  4. Writes results.parquet (DatetimeIndex rows × variable columns).
  5. Writes results_meta.json ({study, built_at, dv_file, gwout_file, simulation_period, variables: {...}}).
  6. Optionally patches catalog.json to add variable_to_node entries and
     node.dss_variables lists.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import pandas as pd

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# DSS variable helpers
# ---------------------------------------------------------------------------

# Common one-character prefixes for node variables:  S_ SHSTA, D_ DELTA, etc.
_NODE_PREFIXES = ("S_", "D_", "G_", "T_", "WTS_", "EG_", "C2V_", "SWP_", "CVP_")


def _strip_prefix(varname: str, cs3_ids: Set[str]) -> Optional[str]:
    """Return the cs3_id if varname maps to a GeoSchematic node, else None."""
    upper = varname.upper()
    for pfx in _NODE_PREFIXES:
        if upper.startswith(pfx):
            candidate = upper[len(pfx):]
            if candidate in cs3_ids:
                return candidate
    return None


def _resolve_feature(varname: str, arc_ids: Set[str], cs3_ids: Set[str]):
    """Return (feature_id, feature_kind) or (None, None)."""
    upper = varname.upper()
    if upper in arc_ids:
        return upper, "arc"
    node = _strip_prefix(upper, cs3_ids)
    if node:
        return node, "node"
    return None, None


# ---------------------------------------------------------------------------
# DSS file helpers
# ---------------------------------------------------------------------------

def _resolve_dss_path(
    study_dir: Path,
    meta_hint: Optional[str],
    prefer_tag: str = "",
) -> Optional[Path]:
    """Return the path to a DSS file, using *meta_hint* from study_meta.json when
    available, otherwise auto-discovering within ``study_dir/DSS/output/``."""
    if meta_hint:
        p = study_dir / meta_hint
        if p.exists():
            return p
        logger.warning("DSS file specified in study_meta.json not found: %s", p)
    # Auto-discover in the standard output directory
    output_dir = study_dir / "DSS" / "output"
    candidates = sorted(output_dir.glob("*.dss")) if output_dir.exists() else []
    if not candidates:
        candidates = sorted(study_dir.rglob("*.dss"))
    if prefer_tag and candidates:
        preferred = [p for p in candidates if prefer_tag.upper() in p.name.upper()]
        if preferred:
            return preferred[0]
    return candidates[0] if candidates else None


def _read_and_match_dss(
    dss_path: Path,
    arc_ids: Set[str],
    cs3_ids: Set[str],
) -> Tuple["pd.DataFrame", Dict[str, Tuple[str, str]], Dict[str, dict]]:
    """Open *dss_path*, match its variables to GeoSchematic features, and read
    all matched time series into a DataFrame.

    Returns
    -------
    df : pd.DataFrame
        Wide DataFrame (DatetimeIndex rows × matched variable columns).
    matched_map : dict
        ``{varname: (feature_id, feature_kind)}`` for every matched variable.
    wresl_meta : dict
        ``{varname: {c_part, b_part}}`` read from the DSS catalog.
    """
    from csview.study.dss_reader import DssFile

    dss = DssFile(dss_path)
    dss.open()
    try:
        all_vars = dss.variables()
    except Exception as exc:
        logger.error("Failed to list variables in %s: %s", dss_path.name, exc)
        dss.close()
        return pd.DataFrame(), {}, {}

    logger.info("  %s: %d variables total", dss_path.name, len(all_vars))

    matched: List[Tuple[str, str, str]] = []
    for var in all_vars:
        fid, fkind = _resolve_feature(var, arc_ids, cs3_ids)
        if fid:
            matched.append((var, fid, fkind))
    logger.info("  Matched %d / %d variables to GeoSchematic features", len(matched), len(all_vars))

    matched_var_names = [var for var, _, _ in matched]

    wresl_meta: Dict[str, dict] = {}
    try:
        cat_obj = dss.catalog()
        for var in matched_var_names:
            paths = cat_obj.get(var, [])
            preferred = next(
                (p for p in paths if p.e.upper() == "1MON"), paths[0] if paths else None
            )
            wresl_meta[var] = {
                "c_part": preferred.c if preferred else "",
                "b_part": preferred.b if preferred else "",
            }
    except Exception:
        pass

    df = dss.read_all(matched_var_names)
    dss.close()
    logger.info("  Read complete: %d variables \u00d7 %d time steps", len(df.columns), len(df))

    matched_map = {var: (fid, fkind) for var, fid, fkind in matched}
    return df, matched_map, wresl_meta


# ---------------------------------------------------------------------------
# Core build function
# ---------------------------------------------------------------------------

def build_results(
    source_dir: Path,
    catalog_path: Path,
    out_dir: Path,
    *,
    patch_catalog: bool = True,
) -> None:
    """Build Parquet + metadata from a raw CalSim study directory.

    Parameters
    ----------
    source_dir:
        Raw study directory containing DSS/ and (optionally) Run/.
        Should live in reference/calsim-studies/ (gitignored).
    catalog_path:
        Path to network/catalog.json.
    out_dir:
        Destination for results.parquet + results_meta.json.
        Should live in study/<name>/ (tracked in git).
    """
    study_dir = Path(source_dir)   # kept as study_dir internally for minimal diff
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # -----------------------------------------------------------------------
    # Read optional study_meta.json from the source directory
    # -----------------------------------------------------------------------
    source_meta_path = study_dir / "study_meta.json"
    source_meta: dict = {}
    if source_meta_path.exists():
        try:
            source_meta = json.loads(source_meta_path.read_text(encoding="utf-8"))
            logger.info("Loaded study_meta.json: name=%s", source_meta.get("name"))
        except Exception as exc:
            logger.warning("Could not read study_meta.json: %s", exc)
    # Logical study name: study_meta.json > source dir name
    study_name = source_meta.get("name") or study_dir.name
    # -----------------------------------------------------------------------
    # Load catalog
    # -----------------------------------------------------------------------
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    arc_ids: Set[str] = {a.upper() for a in catalog.get("arcs", {}).keys()}
    cs3_ids: Set[str] = {n.upper() for n in catalog.get("nodes", {}).keys()}
    logger.info("Catalog: %d arcs, %d nodes", len(arc_ids), len(cs3_ids))

    # -----------------------------------------------------------------------
    # Resolve DSS files (study_meta.json hints take priority over auto-discovery)
    # -----------------------------------------------------------------------
    try:
        from csview.study.dss_reader import DssFile  # noqa: F401 — ensure available
    except ImportError:
        logger.error("pydsstools not available — cannot read DSS files")
        sys.exit(1)

    dv_path = _resolve_dss_path(study_dir, source_meta.get("dv_file"), prefer_tag="_DV_")
    if dv_path is None:
        logger.error("No DV DSS output file found under %s", study_dir)
        sys.exit(1)
    logger.info("DV file: %s", dv_path)

    gwout_path: Optional[Path] = None
    gwout_hint = source_meta.get("gwout_file")
    if gwout_hint:
        p = study_dir / gwout_hint
        if p.exists():
            gwout_path = p
            logger.info("GWOUT file: %s", gwout_path)
        else:
            logger.warning("gwout_file not found: %s — skipping", p)

    # -----------------------------------------------------------------------
    # Read DV file
    # -----------------------------------------------------------------------
    logger.info("Reading DV file...")
    df_dv, matched_map, wresl_meta = _read_and_match_dss(dv_path, arc_ids, cs3_ids)

    # -----------------------------------------------------------------------
    # Read GWOUT file (optional) and merge into df_dv
    # -----------------------------------------------------------------------
    df_raw = df_dv
    if gwout_path is not None:
        logger.info("Reading GWOUT file...")
        df_gw, gw_matched, gw_wresl = _read_and_match_dss(gwout_path, arc_ids, cs3_ids)
        new_cols = [c for c in df_gw.columns if c not in df_dv.columns]
        if new_cols:
            df_raw = pd.concat([df_dv, df_gw[new_cols]], axis=1)
            matched_map.update(gw_matched)
            wresl_meta.update(gw_wresl)
            logger.info("Merged %d GWOUT variables into DataFrame", len(new_cols))
        else:
            already_in_dv = [c for c in df_gw.columns if c in df_dv.columns]
            if already_in_dv:
                logger.info("No new variables from GWOUT (%d already in DV)", len(already_in_dv))
            else:
                logger.info("No variables from GWOUT matched GeoSchematic features — nothing merged")

    # -----------------------------------------------------------------------
    # Clip to simulation_period
    # -----------------------------------------------------------------------
    sim_period = source_meta.get("simulation_period", {})
    sim_start = sim_period.get("start")   # e.g. "1920-10" (YYYY-MM)
    sim_end   = sim_period.get("end")     # e.g. "2021-09"
    if (sim_start or sim_end) and not df_raw.empty:
        before = len(df_raw)
        df_raw = df_raw.loc[sim_start:sim_end]
        logger.info(
            "Clipped to simulation_period %s – %s: %d → %d rows",
            sim_start or "…", sim_end or "…", before, len(df_raw),
        )

    # -----------------------------------------------------------------------
    # Build metadata for matched variables
    # -----------------------------------------------------------------------
    meta_vars: Dict[str, dict] = {}
    for var in df_raw.columns:
        fid, fkind = matched_map.get(var, (var.upper(), "unknown"))
        wm = wresl_meta.get(var, {})
        meta_vars[var] = {
            "feature_id": fid,
            "feature_kind": fkind,
            "c_part": wm.get("c_part", ""),
            "b_part": wm.get("b_part", ""),
            "units": _infer_units(wm.get("c_part", ""), fkind),
            "kind": wm.get("c_part", ""),
        }

    # -----------------------------------------------------------------------
    # Write Parquet
    # -----------------------------------------------------------------------
    if not df_raw.empty:
        df_raw.sort_index(inplace=True)
        parquet_path = out_dir / "results.parquet"
        df_raw.to_parquet(parquet_path)
        date_start = str(df_raw.index.min().date())
        date_end = str(df_raw.index.max().date())
        logger.info("Wrote %s (%d vars × %d rows)", parquet_path, len(df_raw.columns), len(df_raw))
    else:
        logger.warning("No data to write; skipping parquet")
        date_start = date_end = None

    # -----------------------------------------------------------------------
    # Write metadata JSON
    # -----------------------------------------------------------------------
    # Build node_dss_variables index: {CS3_ID_UPPER: [DSS_var, ...]}
    node_dss_vars: Dict[str, List[str]] = {}
    var_to_node: Dict[str, str] = {}
    for var, meta in meta_vars.items():
        if meta["feature_kind"] == "node":
            fid = meta["feature_id"]
            node_dss_vars.setdefault(fid, []).append(var)
            var_to_node[var] = fid

    meta_doc = {
        "study": study_name,
        "built_at": datetime.utcnow().isoformat() + "Z",
        "dv_file": str(dv_path),
        "gwout_file": str(gwout_path) if gwout_path else None,
        "simulation_period": sim_period if (sim_start or sim_end) else None,
        "date_range": {"start": date_start, "end": date_end},
        "variables": meta_vars,
        "node_dss_variables": node_dss_vars,
    }
    if source_meta.get("description"):
        meta_doc["description"] = source_meta["description"]
    meta_path = out_dir / "results_meta.json"
    meta_path.write_text(json.dumps(meta_doc, indent=2), encoding="utf-8")
    logger.info("Wrote %s", meta_path)

    # -----------------------------------------------------------------------
    # Patch catalog.json
    # -----------------------------------------------------------------------
    if patch_catalog:
        _patch_catalog(catalog_path, var_to_node, node_dss_vars)


def _infer_units(c_part: str, feature_kind: str) -> str:
    """Heuristically infer units from the DSS C-part string."""
    cp = c_part.upper()
    if "FLOW" in cp or "CHANNEL" in cp or "DIVERSION" in cp:
        return "CFS"
    if "STORAGE" in cp or "SHORTAGE" in cp:
        return "TAF"
    if "GROUNDWATER" in cp or "GW" in cp:
        return "TAF"
    return ""


def _patch_catalog(catalog_path: Path, var_to_node: Dict[str, str], node_dss_vars: Dict[str, List[str]]) -> None:
    """Update catalog.json with new variable_to_node entries and node dss_variables."""
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    existing_v2n = catalog.get("variable_to_node", {})
    existing_v2n.update(var_to_node)
    catalog["variable_to_node"] = existing_v2n
    for cs3_id_upper, vars_list in node_dss_vars.items():
        # Look up node (key might be upper or lower)
        node_entry = catalog["nodes"].get(cs3_id_upper) or catalog["nodes"].get(cs3_id_upper.lower())
        if node_entry is not None:
            node_entry["dss_variables"] = vars_list
    catalog_path.write_text(json.dumps(catalog, indent=2), encoding="utf-8")
    logger.info("Patched catalog.json: %d variable_to_node entries", len(existing_v2n))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="python -m csview.study",
        description="Pre-build Parquet results from a CalSim study DSS file",
    )
    parser.add_argument(
        "--source",
        type=Path,
        required=True,
        metavar="SOURCE_DIR",
        help="Raw study directory containing DSS/, Run/, and optional study_meta.json (e.g. reference/calsim-studies/study_a)",
    )
    parser.add_argument(
        "--catalog",
        type=Path,
        required=True,
        metavar="CATALOG_JSON",
        help="Path to network/catalog.json",
    )
    parser.add_argument(
        "--out",
        type=Path,
        required=True,
        metavar="OUT_DIR",
        help="Output directory for compiled artifacts, e.g. data/study/study_a/",
    )
    parser.add_argument(
        "--no-patch-catalog",
        action="store_true",
        help="Skip updating catalog.json with variable_to_node entries",
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s — %(message)s",
        stream=sys.stdout,
    )

    build_results(
        source_dir=args.source,
        catalog_path=args.catalog,
        out_dir=args.out,
        patch_catalog=not args.no_patch_catalog,
    )
    print("\nDone.")


if __name__ == "__main__":
    main()
