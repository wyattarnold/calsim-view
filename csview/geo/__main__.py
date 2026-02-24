"""
CLI builder: GeoSchematic → network artifacts (network.geojson + catalog.json).

Usage
-----
    python -m csview.geo \\
        --geo-dir  reference/geoschematic \\
        --wresl    reference/calsim-studies/study_a/Run/System \\
        --out      data/network/

Produces
--------
network/
    catalog.json          — node/arc metadata + variable_to_node index
    network.geojson       — GeoJSON FeatureCollection (nodes + arcs)
    watersheds.geojson    — pass-through overlay
    water_budget_areas.geojson
    demand_units.geojson
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import asdict
from pathlib import Path

from csview.geo.loader import load_from_dir


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="csview.geo",
        description="Build CalSim 3 network artifacts from the Geographic Schematic.",
    )
    parser.add_argument(
        "--geo-dir",
        type=Path,
        required=True,
        help="Directory containing the CalSim3 GeoSchematic GeoJSON files.",
    )
    parser.add_argument(
        "--wresl",
        type=Path,
        default=None,
        metavar="SYSTEM_DIR",
        help="Optional: WRESL Run/System/ directory (enriches arcs with kind/units).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("network"),
        help="Output directory (default: ./network/).",
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s - %(message)s",
        stream=sys.stdout,
    )

    # -----------------------------------------------------------------------
    # 1. Load GeoSchematic
    # -----------------------------------------------------------------------
    gn = load_from_dir(args.geo_dir, wresl_dir=args.wresl)

    # -----------------------------------------------------------------------
    # 2. Write output directory
    # -----------------------------------------------------------------------
    out = args.out
    out.mkdir(parents=True, exist_ok=True)

    # catalog.json
    catalog = {
        "nodes": {
            cs3_id: {
                "cs3_id":       node.cs3_id,
                "description":  node.description,
                "node_type":    node.node_type,
                "lon":          node.lon,
                "lat":          node.lat,
                "hydro_region": node.hydro_region,
                "river_name":   node.river_name,
                "nearest_gage": node.nearest_gage,
                "stream_code":  node.stream_code,
                "river_mile":   node.river_mile,
                "c2vsim_gw":    node.c2vsim_gw,
                "c2vsim_sw":    node.c2vsim_sw,
                "calsim2_id":   node.calsim2_id,
                "dss_variables": node.dss_variables,
            }
            for cs3_id, node in gn.nodes.items()
        },
        "arcs": {
            arc_id: {
                "arc_id":      arc.arc_id,
                "name":        arc.name,
                "arc_type":    arc.arc_type,
                "sub_type":    arc.sub_type,
                "from_node":   arc.from_node,
                "to_node":     arc.to_node,
                "hydro_region": arc.hydro_region,
                "description": arc.description,
                "coordinates": arc.coordinates,
                "units":       arc.units,
                "kind":        arc.kind,
            }
            for arc_id, arc in gn.arcs.items()
        },
        "variable_to_node": gn.variable_to_node,
    }
    cat_path = out / "catalog.json"
    cat_path.write_text(json.dumps(catalog, separators=(",", ":")), encoding="utf-8")
    print(f"  catalog.json    ({len(gn.nodes)} nodes, {len(gn.arcs)} arcs)")

    # network.geojson
    geojson_path = out / "network.geojson"
    geojson_path.write_text(
        json.dumps(gn.geojson, separators=(",", ":")), encoding="utf-8"
    )
    print(f"  network.geojson ({len(gn.geojson['features'])} features)")

    # Overlay layers
    for attr, fname in (
        ("watersheds_geojson",   "watersheds.geojson"),
        ("water_budget_geojson", "water_budget_areas.geojson"),
        ("demand_unit_geojson",  "demand_units.geojson"),
    ):
        data = getattr(gn, attr, {})
        if data.get("features"):
            (out / fname).write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
            print(f"  {fname} ({len(data['features'])} features)")

    print(f"\nNetwork artifacts written to: {out}/")
    if gn.variable_to_node:
        print(f"  variable->node mappings: {len(gn.variable_to_node)}")
    else:
        print(
            "  NOTE: no variable->node mappings built."
            " Run the results builder next to populate them."
        )


if __name__ == "__main__":
    main()
