"""
Load the CalSim 3 GeoSchematic GeoJSON files into a GeoNetwork.

Two entry points
----------------
``load_from_dir(geo_dir, wresl_dir=None)``
    Build a GeoNetwork in-memory from the raw GeoJSON files.  Optionally
    enriches arcs with kind/units from a WRESL System/ directory.  Used by
    the builder CLI to construct and persist the catalog.

``load_from_catalog(catalog_dir)``
    Fast load from the pre-built ``catalog.json`` (and accompanying GeoJSON)
    written by the builder.  Used by the app at startup.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import List, Optional

from .models import ARC_TYPE_MAP, GeoArc, GeoNetwork, GeoNode, node_type_from_description

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# GeoSchematic file names
# ---------------------------------------------------------------------------

NODES_FILE = "i12_CalSim3Model_Nodes_20221021.geojson"
ARCS_FILE = "i12_CalSim3Model_Arcs_20221021.geojson"
WATERSHEDS_FILE = "i12_CalSim3Model_Allwatersheds_20221021.geojson"
WATER_BUDGET_FILE = "i12_CalSim3Model_WaterBudgetAreas_20221021.geojson"
DEMAND_UNIT_FILE = "i12_CalSim3Model_DemandUnit_20221021.geojson"

CATALOG_FILE = "catalog.json"


def load_from_dir(
    geo_dir: Path,
    wresl_dir: Optional[Path] = None,
) -> GeoNetwork:
    """Build a GeoNetwork from raw GeoSchematic GeoJSON files.

    Parameters
    ----------
    geo_dir:
        Directory containing the CalSim3 GeoSchematic GeoJSON files
        (e.g. ``reference/geoschematic/``).
    wresl_dir:
        Optional path to a WRESL ``Run/System/`` directory.  When provided,
        ``kind`` and ``units`` fields on arcs are populated from the WRESL
        catalog.

    Returns
    -------
    GeoNetwork
        Fully populated network.  ``variable_to_node`` is built from the WRESL
        catalog when *wresl_dir* is supplied; otherwise it is left empty and
        populated later (e.g. by the results builder when the DSS catalog is
        available).
    """
    geo_dir = Path(geo_dir)
    gn = GeoNetwork()

    _load_nodes(gn, geo_dir)
    _load_arcs(gn, geo_dir)
    _load_overlays(gn, geo_dir)

    if wresl_dir is not None:
        _enrich_from_wresl(gn, Path(wresl_dir))
        _build_variable_index_from_wresl(gn, Path(wresl_dir))

    _build_geojson(gn)

    logger.info(
        "GeoNetwork ready: %d nodes, %d arcs, %d variable->node mappings",
        len(gn.nodes),
        len(gn.arcs),
        len(gn.variable_to_node),
    )
    return gn


def load_from_catalog(catalog_dir: Path) -> GeoNetwork:
    """Fast-load a GeoNetwork from a pre-built catalog directory.

    Expects the directory to contain:
    - ``catalog.json``   — node/arc metadata + variable_to_node index
    - ``network.geojson`` — pre-built FeatureCollection (loaded as-is)
    - Optionally: ``watersheds.geojson``, ``water_budget_areas.geojson``,
      ``demand_units.geojson``

    Parameters
    ----------
    catalog_dir:
        Path to the directory written by the geo builder (e.g. ``network/``).
    """
    catalog_dir = Path(catalog_dir)
    cat_path = catalog_dir / CATALOG_FILE

    if not cat_path.exists():
        raise FileNotFoundError(
            f"catalog.json not found in {catalog_dir}. "
            "Run: python -m csview.geo --geo-dir <...> --out <...>"
        )

    cat = json.loads(cat_path.read_text(encoding="utf-8"))
    gn = GeoNetwork()

    # Nodes
    for cs3_id_upper, d in cat.get("nodes", {}).items():
        gn.nodes[cs3_id_upper] = GeoNode(
            cs3_id=d["cs3_id"],
            description=d["description"],
            node_type=d["node_type"],
            lon=d["lon"],
            lat=d["lat"],
            hydro_region=d.get("hydro_region", ""),
            river_name=d.get("river_name", ""),
            nearest_gage=d.get("nearest_gage", ""),
            stream_code=d.get("stream_code", ""),
            river_mile=d.get("river_mile"),
            c2vsim_gw=d.get("c2vsim_gw", ""),
            c2vsim_sw=d.get("c2vsim_sw", ""),
            calsim2_id=d.get("calsim2_id", ""),
            dss_variables=d.get("dss_variables", []),
            missing_arcs=d.get("missing_arcs", []),
        )

    # Arcs
    for arc_id_upper, d in cat.get("arcs", {}).items():
        gn.arcs[arc_id_upper] = GeoArc(
            arc_id=d["arc_id"],
            name=d.get("name", ""),
            arc_type=d.get("arc_type", ""),
            sub_type=d.get("sub_type", ""),
            from_node=d.get("from_node"),
            to_node=d.get("to_node"),
            hydro_region=d.get("hydro_region", ""),
            description=d.get("description", ""),
            coordinates=d.get("coordinates", []),
            units=d.get("units"),
            kind=d.get("kind"),
            capacity_cfs=d.get("capacity_cfs"),
            solver_active=d.get("solver_active", True),
            wresl_suggestion=d.get("wresl_suggestion"),
        )

    gn.variable_to_node = cat.get("variable_to_node", {})

    # GeoJSON FeatureCollection
    geojson_path = catalog_dir / "network.geojson"
    if geojson_path.exists():
        gn.geojson = json.loads(geojson_path.read_text(encoding="utf-8"))
    else:
        logger.warning("network.geojson not found in %s; rebuilding GeoJSON", catalog_dir)
        _build_geojson(gn)

    # Overlay layers (optional)
    for attr, fname in (
        ("watersheds_geojson", "watersheds.geojson"),
        ("water_budget_geojson", "water_budget_areas.geojson"),
        ("demand_unit_geojson", "demand_units.geojson"),
    ):
        p = catalog_dir / fname
        if p.exists():
            setattr(gn, attr, json.loads(p.read_text(encoding="utf-8")))

    logger.info(
        "GeoNetwork loaded from catalog: %d nodes, %d arcs, %d variable->node mappings",
        len(gn.nodes),
        len(gn.arcs),
        len(gn.variable_to_node),
    )
    return gn


def rebuild_geojson(gn: GeoNetwork) -> None:
    """Rebuild the in-memory GeoJSON FeatureCollection from current node/arc state.

    Call this after patching arc topology (from_node / to_node / solver_active)
    to ensure the GeoJSON served to the frontend reflects the corrected data.
    """
    _build_geojson(gn)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _load_nodes(gn: GeoNetwork, geo_dir: Path) -> None:
    path = geo_dir / NODES_FILE
    if not path.exists():
        logger.warning("Nodes GeoJSON not found: %s", path)
        return
    data = json.loads(path.read_text(encoding="utf-8"))
    count = 0
    for feat in data.get("features", []):
        p = feat["properties"]
        cs3_id = (p.get("CalSim 3 ID") or "").strip()
        if not cs3_id:
            continue
        coords = feat["geometry"]["coordinates"]
        rm = p.get("RiverMile_Actual")
        desc = (p.get("NodeDescription") or "").strip()
        gn.nodes[cs3_id.upper()] = GeoNode(
            cs3_id=cs3_id,
            description=desc,
            node_type=node_type_from_description(desc),
            lon=float(coords[0]),
            lat=float(coords[1]),
            hydro_region=(p.get("HydroRegion") or "").strip(),
            river_name=(p.get("RiverName") or "").strip(),
            nearest_gage=(p.get("Nearest_Gage") or "").strip(),
            stream_code=(p.get("Stream_Code") or "").strip(),
            river_mile=float(rm) if rm is not None else None,
            c2vsim_gw=(p.get("C2VSIM_GroundWater") or "").strip(),
            c2vsim_sw=(p.get("C2VSIM_SurfaceWater") or "").strip(),
            calsim2_id=(p.get("CalSim2_ID") or "").strip(),
        )
        count += 1
    logger.info("Loaded %d nodes", count)


def _load_arcs(gn: GeoNetwork, geo_dir: Path) -> None:
    path = geo_dir / ARCS_FILE
    if not path.exists():
        logger.warning("Arcs GeoJSON not found: %s", path)
        return
    data = json.loads(path.read_text(encoding="utf-8"))
    count = 0
    for feat in data.get("features", []):
        p = feat["properties"]
        arc_id = (p.get("Arc_ID") or "").strip()
        if not arc_id:
            continue
        arc_type_raw = (p.get("Type") or "").strip()
        arc_type = ARC_TYPE_MAP.get(arc_type_raw, arc_type_raw or "Other")
        geom = feat.get("geometry") or {}
        gtype = geom.get("type", "")
        if gtype == "LineString":
            coords = geom["coordinates"]
        elif gtype == "MultiLineString":
            coords = [c for part in geom["coordinates"] for c in part]
        else:
            coords = []
        fn = (p.get("From_Node") or "").strip() or None
        tn_raw = (p.get("To_Node") or "").strip()
        tn = tn_raw if tn_raw and tn_raw.upper() != "N/A" else None
        gn.arcs[arc_id.upper()] = GeoArc(
            arc_id=arc_id,
            name=(p.get("NAME") or "").strip(),
            arc_type=arc_type,
            sub_type=(p.get("Sub_Type") or "").strip(),
            from_node=fn,
            to_node=tn,
            hydro_region=(p.get("HydroRegion") or "").strip(),
            description=(p.get("ArcDescription") or "").strip(),
            coordinates=coords,
        )
        count += 1
    logger.info("Loaded %d arcs", count)


def _load_overlays(gn: GeoNetwork, geo_dir: Path) -> None:
    for attr, fname in (
        ("watersheds_geojson", WATERSHEDS_FILE),
        ("water_budget_geojson", WATER_BUDGET_FILE),
        ("demand_unit_geojson", DEMAND_UNIT_FILE),
    ):
        p = geo_dir / fname
        if p.exists():
            setattr(gn, attr, json.loads(p.read_text(encoding="utf-8")))
            logger.debug("Loaded overlay: %s", fname)


def _enrich_from_wresl(gn: GeoNetwork, wresl_dir: Path) -> None:
    """Populate arc kind/units from WRESL variable definitions."""
    try:
        from csview.geo.wresl_parser import parse_system_tables
    except ImportError:
        logger.warning("wresl_parser not available; skipping WRESL enrichment")
        return
    catalog = parse_system_tables(wresl_dir)
    enriched = 0
    for arc_id_upper, arc in gn.arcs.items():
        wv = catalog.get(arc.arc_id)
        if wv:
            arc.kind = wv.kind
            arc.units = wv.units
            if wv.capacity is not None:
                arc.capacity_cfs = wv.capacity
            enriched += 1
    logger.info("WRESL enrichment: %d/%d arcs updated", enriched, len(gn.arcs))


def _build_variable_index_from_wresl(gn: GeoNetwork, wresl_dir: Path) -> None:
    """Build variable_to_node mapping from WRESL catalog.

    For every WRESL variable, attempt to match it to a GeoSchematic node by
    stripping the first prefix token (e.g. "S_SHSTA" → "SHSTA").
    """
    try:
        from csview.geo.wresl_parser import parse_system_tables
    except ImportError:
        return
    catalog = parse_system_tables(wresl_dir)
    count = 0
    for varname in catalog.variables:
        if varname.upper() in gn.arcs:
            continue            # already an arc — not a node variable
        body = _strip_prefix(varname).upper()
        if body in gn.nodes:
            gn.variable_to_node[varname.upper()] = body
            count += 1
    logger.info("Built variable->node index: %d entries", count)


def _strip_prefix(name: str) -> str:
    """Strip the first prefix token: 'S_SHSTA' → 'SHSTA'."""
    parts = name.split("_", 1)
    return parts[1] if len(parts) == 2 else name


def _build_geojson(gn: GeoNetwork) -> None:
    """Build the in-memory GeoJSON FeatureCollection from nodes + arcs."""
    features = []

    # Arcs first (drawn as LineStrings — below points)
    for arc in gn.arcs.values():
        if len(arc.coordinates) < 2:
            continue
        coords = _simplify(arc.coordinates, max_pts=300)
        feat = {
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {
                "feature_id":   arc.arc_id,
                "feature_kind": "arc",
                "arc_type":       arc.arc_type,
                "name":           arc.name,
                "sub_type":       arc.sub_type,
                "from_node":      arc.from_node,
                "to_node":        arc.to_node,
                "hydro_region":   arc.hydro_region,
                "description":    arc.description,
                "units":          arc.units,
                "kind":           arc.kind,
                "capacity_cfs":   arc.capacity_cfs,
                "solver_active":  arc.solver_active,
                "wresl_suggestion": arc.wresl_suggestion,
            },
        }
        features.append(feat)

    # Nodes (Points — rendered on top)
    for node in gn.nodes.values():
        feat = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [node.lon, node.lat]},
            "properties": {
                "feature_id":   node.cs3_id,
                "feature_kind": "node",
                "node_type":    node.node_type,
                "description":  node.description,
                "river_name":   node.river_name,
                "hydro_region": node.hydro_region,
                "nearest_gage": node.nearest_gage,
                "stream_code":  node.stream_code,
                "river_mile":   node.river_mile,
                "c2vsim_gw":    node.c2vsim_gw,
                "c2vsim_sw":    node.c2vsim_sw,
                "calsim2_id":   node.calsim2_id,
                "dss_variables": node.dss_variables,
                "missing_arcs":  node.missing_arcs,
            },
        }
        features.append(feat)

    gn.geojson = {"type": "FeatureCollection", "features": features}
    logger.info("Built GeoJSON: %d features total", len(features))


def _simplify(coords: List, max_pts: int) -> List:
    """Thin coords list to at most *max_pts* points (uniform sampling)."""
    if len(coords) <= max_pts:
        return coords
    step = max(1, len(coords) // max_pts)
    result = coords[::step]
    if result[-1] != coords[-1]:
        result = result + [coords[-1]]
    return result
