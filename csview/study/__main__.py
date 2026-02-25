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

# Prefixes that map a DSS variable name to a GeoSchematic node cs3_id.
# Rules:
#   • Longer prefixes MUST appear before shorter ones that share the same
#     leading characters (e.g. "GP_" before "G_") to prevent partial stripping.
#   • Add new prefixes in length-descending order within each group.
#
# Prefix glossary (CalSim 3 DV naming conventions):
#   AW_      agricultural water (applied)
#   C2V_     C2VSim-linked demand node
#   CVP_     Central Valley Project delivery
#   DG_      demand — groundwater component
#   DL_      demand — delivery level
#   DN_      demand — native surface water
#   DP_      demand — delivery percent
#   EG_      estimated groundwater
#   EL_      evapotranspiration (local?)
#   EV_      evapotranspiration
#   GP_      groundwater pumping
#   LF_      local flows / local surface water
#   MF_      minimum flow requirement
#   OS_      outflow / seepage
#   PEAKAW_  peak agricultural water demand
#   RP_      riparian recovery / return flow
#   RU_      return flow — urban
#   SHRTG_   shortage
#   SL_      seepage loss
#   SUMAW_   sum of agricultural water deliveries
#   SUMUD_   sum of urban demand
#   SWP_     State Water Project delivery
#   SWDEM_   surface water demand (e.g. SWDEM_02_PADV → node 02_PA with DV suffix stripped)
#   WTS_     water transfer / wheeling supply
#   XNM_TOTAL_ total non-market exchange
_NODE_PREFIXES = (
    # Longest compound prefixes first
    "XNM_TOTAL_",
    "SWDEM_",
    "PEAKAW_",
    "SUMAW_",
    "SUMUD_",
    "SHRTG_",
    # 4-character prefixes
    "C2V_",
    "CVP_",
    "SWP_",
    "WTS_",
    # 3-character prefixes — longer before shorter with same root
    "AW_",
    "DG_",
    "DL_",
    "DN_",
    "DP_",
    "EG_",
    "EL_",
    "EV_",
    "GP_",
    "LF_",
    "MF_",
    "OS_",
    "RP_",
    "RU_",
    "SL_",
    # 2-character prefixes (single letter + underscore)
    "A_",
    "C_",
    "D_",
    "E_",
    "F_",
    "G_",
    "R_",
    "S_",
    "T_",
    "X_",
)


# Arc features whose flow is split across multiple DSS variables that don't
# share the arc's name.  These are explicitly extracted and stored under
# arc_dss_variables in results_meta.json so the app can look them up.
# Key: arc_id (uppercase); Value: list of DSS variable names to extract.
ARC_DSS_OVERRIDES: Dict[str, List[str]] = {
    "C_SAC000_MIN": ["NDOI_MIN"],
    "C_SAC000_ADD": ["NDOI_ADD"],
}

# CalSim DV naming appends short tags to node IDs for some variable families.
# After stripping the prefix, also try removing these to find a node match.
_NODE_TRAILING_TAGS = ("DV",)


def _strip_prefix(varname: str, cs3_ids: Set[str]) -> Optional[str]:
    """Return the cs3_id if varname maps to a GeoSchematic node, else None."""
    upper = varname.upper()
    for pfx in _NODE_PREFIXES:
        if upper.startswith(pfx):
            candidate = upper[len(pfx):]
            if candidate in cs3_ids:
                return candidate
            # Try stripping known trailing tags (e.g. "DV" in SWDEM_02_PADV)
            for tag in _NODE_TRAILING_TAGS:
                if candidate.endswith(tag):
                    trimmed = candidate[: -len(tag)]
                    if trimmed in cs3_ids:
                        return trimmed
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

    # Read each matched variable; capture DSS-native units from series.attrs
    # (read_timeseries populates attrs['units'] from the ts object).
    frames: Dict[str, pd.Series] = {}
    for var in matched_var_names:
        try:
            s = dss.read_timeseries(var)
            frames[var] = s
            dss_units = s.attrs.get("units", "")
            if dss_units and var in wresl_meta:
                wresl_meta[var]["dss_units"] = dss_units
        except Exception as exc:
            logger.debug("Skipping %s: %s", var, exc)
    dss.close()
    df = pd.concat(frames, axis=1) if frames else pd.DataFrame()
    logger.info("  Read complete: %d variables \u00d7 %d time steps", len(df.columns), len(df) if not df.empty else 0)

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

    # Also include wresl_suggestion target arc IDs so their DSS variables are
    # extracted even though they have no GeoSchematic geometry.  This enables
    # the app's fallback: when a geo arc has no direct DSS data, the study
    # router serves the suggestion's time series instead.
    suggestion_ids: Set[str] = set()
    for arc_data in catalog.get("arcs", {}).values():
        ws = arc_data.get("wresl_suggestion")
        if ws:
            suggestion_ids.add(ws.upper())
    arc_ids_plus = arc_ids | suggestion_ids

    logger.info(
        "Catalog: %d arcs, %d nodes (+%d wresl_suggestion targets)",
        len(arc_ids), len(cs3_ids), len(suggestion_ids),
    )

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

    sv_path: Optional[Path] = None
    sv_hint = source_meta.get("sv_file")
    if sv_hint:
        p = study_dir / sv_hint
        if p.exists():
            sv_path = p
            logger.info("SV file: %s", sv_path)
        else:
            logger.warning("sv_file not found: %s — skipping", p)
    else:
        # Auto-discover SV in DSS/input/ (SV files are inputs, not outputs)
        input_dir = study_dir / "DSS" / "input"
        sv_candidates = sorted(input_dir.glob("*.dss")) if input_dir.exists() else []
        preferred = [p for p in sv_candidates if "_SV_" in p.name.upper()]
        sv_path = (preferred or sv_candidates or [None])[0]
        if sv_path:
            logger.info("SV file (auto-discovered): %s", sv_path)

    # -----------------------------------------------------------------------
    # Read DV file
    # -----------------------------------------------------------------------
    logger.info("Reading DV file...")
    df_dv, matched_map, wresl_meta = _read_and_match_dss(dv_path, arc_ids_plus, cs3_ids)

    # -----------------------------------------------------------------------
    # Read GWOUT file (optional) and merge into df_dv
    # -----------------------------------------------------------------------
    df_raw = df_dv
    if gwout_path is not None:
        logger.info("Reading GWOUT file...")
        df_gw, gw_matched, gw_wresl = _read_and_match_dss(gwout_path, arc_ids_plus, cs3_ids)
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
    # Read SV file (optional) and merge new-only columns
    # -----------------------------------------------------------------------
    if sv_path is not None:
        logger.info("Reading SV file...")
        df_sv, sv_matched, sv_wresl = _read_and_match_dss(sv_path, arc_ids_plus, cs3_ids)
        new_cols = [c for c in df_sv.columns if c not in df_raw.columns]
        if new_cols:
            df_raw = pd.concat([df_raw, df_sv[new_cols]], axis=1)
            matched_map.update(sv_matched)
            wresl_meta.update(sv_wresl)
            logger.info("Merged %d SV variables into DataFrame", len(new_cols))
        else:
            logger.info("No new variables from SV (%d already in DV/GWOUT)", len(df_sv.columns))

    # -----------------------------------------------------------------------
    # Extract arc DSS override variables (e.g. NDOI_MIN / NDOI_ADD for C_SAC000)
    # These don't match any GeoSchematic feature name so they are pulled
    # explicitly from the DV file and merged into df_raw.
    # -----------------------------------------------------------------------
    arc_dss_vars: Dict[str, List[str]] = {}
    if ARC_DSS_OVERRIDES:
        from csview.study.dss_reader import DssFile
        dss_ov = DssFile(dv_path)
        dss_ov.open()
        override_frames: Dict[str, pd.Series] = {}
        override_meta: Dict[str, dict] = {}
        try:
            cat_ov = dss_ov.catalog()
        except Exception:
            cat_ov = {}
        for arc_id_upper, dss_vars in ARC_DSS_OVERRIDES.items():
            extracted: List[str] = []
            for dv in dss_vars:
                if dv in df_raw.columns:
                    extracted.append(dv)
                    continue
                try:
                    s = dss_ov.read_timeseries(dv)
                    override_frames[dv] = s
                    paths = cat_ov.get(dv, [])
                    preferred = next(
                        (p for p in paths if p.e.upper() == "1MON"),
                        paths[0] if paths else None,
                    )
                    override_meta[dv] = {
                        "c_part": preferred.c if preferred else "FLOW",
                        "b_part": preferred.b if preferred else "",
                        "dss_units": s.attrs.get("units", "CFS"),
                    }
                    extracted.append(dv)
                    logger.info("  Extracted override variable %s for arc %s", dv, arc_id_upper)
                except Exception as exc:
                    logger.warning("  Could not read override variable %s: %s", dv, exc)
            if extracted:
                arc_dss_vars[arc_id_upper] = extracted
        dss_ov.close()
        if override_frames:
            df_ov = pd.concat(override_frames, axis=1)
            new_ov_cols = [c for c in df_ov.columns if c not in df_raw.columns]
            if new_ov_cols:
                df_raw = pd.concat([df_raw, df_ov[new_ov_cols]], axis=1)
                for dv in new_ov_cols:
                    om = override_meta.get(dv, {})
                    matched_map[dv] = (dv, "arc")
                    wresl_meta[dv] = om
                logger.info("  Merged %d arc override variables", len(new_ov_cols))

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
            "units": wm.get("dss_units") or _infer_units(wm.get("c_part", ""), fkind),
            "kind": wm.get("c_part", ""),
        }

    # -----------------------------------------------------------------------
    # Normalise arc units: convert any TAF arc columns → CFS so all flow
    # variables share the same unit (CFS) in the Parquet.
    # TAF→CFS: multiply by (1000 * 43560) / (days_in_month * 86400)
    # -----------------------------------------------------------------------
    if not df_raw.empty:
        taf_arc_cols = [
            v for v, m in meta_vars.items()
            if m["feature_kind"] == "arc" and m["units"].upper() == "TAF"
            and v in df_raw.columns
        ]
        if taf_arc_cols:
            days = df_raw.index.days_in_month.values  # shape (n_rows,)
            cfs_factor = (1000 * 43560) / (days * 86400)  # shape (n_rows,)
            import numpy as np
            df_raw[taf_arc_cols] = df_raw[taf_arc_cols].multiply(cfs_factor, axis=0)
            for v in taf_arc_cols:
                meta_vars[v]["units"] = "CFS"
            logger.info("Converted %d TAF arc columns → CFS", len(taf_arc_cols))

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
        "sv_file": str(sv_path) if sv_path else None,
        "simulation_period": sim_period if (sim_start or sim_end) else None,
        "date_range": {"start": date_start, "end": date_end},
        "variables": meta_vars,
        "node_dss_variables": node_dss_vars,
        "arc_dss_variables": arc_dss_vars,
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
    if "DEMAND" in cp:
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
