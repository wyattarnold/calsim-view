"""
Geometry simplification for overlay GeoJSON files.

Called automatically by ``python -m csview.geo`` when writing overlay layers
(watersheds, water_budget_areas, demand_units) to disk.  Uses Douglas-Peucker
simplification via Shapely; falls back to coordinate rounding only if Shapely
is not installed.  Pass ``--no-simplify`` to the geo builder to skip entirely.
"""
from __future__ import annotations

import logging
from typing import Any, Dict

log = logging.getLogger(__name__)

# Per-filename simplification tolerances (degrees, WGS-84).
#   demand_units :  ~0.0003° ≈  33 m — conservative, district-level parcels
#   watersheds   :  ~0.001°  ≈ 111 m — coarse watershed boundaries
#   water_budget :  ~0.001°  ≈ 111 m
OVERLAY_TOLERANCES: Dict[str, float] = {
    "demand_units.geojson":       0.0003,
    "watersheds.geojson":         0.001,
    "water_budget_areas.geojson": 0.001,
}

# Decimal places retained for coordinates — ~1 m resolution.
# WGS-84 lat/lon doesn't benefit from more than 6 digits.
COORD_PRECISION = 5


def _round_coords(obj: Any, precision: int = COORD_PRECISION) -> Any:
    if isinstance(obj, float):
        return round(obj, precision)
    if isinstance(obj, list):
        return [_round_coords(x, precision) for x in obj]
    return obj


def _count_verts(geom: Dict[str, Any]) -> int:
    t = geom.get("type", "")
    if t == "Polygon":
        return sum(len(r) for r in geom["coordinates"])
    if t == "MultiPolygon":
        return sum(sum(len(r) for r in poly) for poly in geom["coordinates"])
    return 0


def simplify_geojson(
    data: Dict[str, Any],
    tolerance: float,
    *,
    coord_precision: int = COORD_PRECISION,
) -> Dict[str, Any]:
    """Return a new GeoJSON dict with simplified + rounded geometry.

    Uses Shapely Douglas-Peucker with ``preserve_topology=True``.
    Falls back to the original dict (with coordinate rounding only) if
    Shapely is not installed.

    Parameters
    ----------
    data:
        A GeoJSON FeatureCollection dict (not modified in-place).
    tolerance:
        Douglas-Peucker tolerance in degrees.
    coord_precision:
        Number of decimal places to retain on coordinates.
    """
    try:
        from shapely.geometry import shape, mapping  # type: ignore
        from shapely.validation import make_valid    # type: ignore
        _have_shapely = True
    except ImportError:
        log.warning("shapely not installed — geometry simplification skipped (coordinate rounding only).")
        _have_shapely = False

    before_verts = after_verts = 0
    new_features = []

    for feat in data.get("features", []):
        geom = feat.get("geometry")
        if not geom:
            new_features.append(feat)
            continue

        if _have_shapely:
            s = shape(geom)
            if not s.is_valid:
                s = make_valid(s)
            before_verts += _count_verts(mapping(s))

            s2 = s.simplify(tolerance, preserve_topology=True)
            m2 = dict(mapping(s2))
            after_verts += _count_verts(m2)
        else:
            m2 = dict(geom)

        m2["coordinates"] = _round_coords(m2["coordinates"], coord_precision)
        new_features.append({**feat, "geometry": m2})

    if _have_shapely and before_verts:
        pct = 100 - after_verts / before_verts * 100
        log.info(
            "    vertices: %s → %s  (%.0f%% reduction)",
            f"{before_verts:,}", f"{after_verts:,}", pct,
        )

    return {**data, "features": new_features}
