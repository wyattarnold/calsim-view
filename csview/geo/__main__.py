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
    parser.add_argument(
        "--diagnose",
        action="store_true",
        help="Run topology diagnostics (requires --wresl) and write network_diagnostics.json.",
    )
    parser.add_argument(
        "--fix-topology",
        action="store_true",
        help=(
            "Patch from_node/to_node mismatches using WRESL-derived endpoints "
            "(requires --diagnose). Does not modify source GeoJSON."
        ),
    )
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
    # 2. Optional topology diagnostics + in-memory patches
    # -----------------------------------------------------------------------
    out = args.out
    out.mkdir(parents=True, exist_ok=True)

    report = None
    if args.diagnose:
        if args.wresl is None:
            print("\nWARNING: --diagnose requires --wresl; skipping diagnostics.")
        else:
            from csview.geo.diagnostics import run_diagnostics
            from csview.geo.loader import rebuild_geojson
            from csview.geo.wresl_parser import parse_connectivity, parse_system_tables

            wresl_cat = parse_system_tables(args.wresl)
            connectivity = parse_connectivity(args.wresl)
            report = run_diagnostics(gn, connectivity, wresl_catalog=wresl_cat)

            # Mark arcs with GeoJSON geometry that never appear in any
            # WRESL flow-balance equation as solver_active=False.
            no_conn_ids = {i.feature_id for i in report.by_kind("arc_no_connectivity")}
            for arc_id in no_conn_ids:
                if arc_id in gn.arcs:
                    gn.arcs[arc_id].solver_active = False
            if no_conn_ids:
                print(f"  solver_active=False applied to {len(no_conn_ids)} arcs.")

            # Optional: patch from_node / to_node for confirmed mismatches.
            if args.fix_topology:
                n_from = n_to = 0
                for iss in report.by_kind("from_node_mismatch"):
                    if iss.feature_id in gn.arcs and iss.wresl_value:
                        gn.arcs[iss.feature_id].from_node = iss.wresl_value
                        n_from += 1
                for iss in report.by_kind("to_node_mismatch"):
                    if iss.feature_id in gn.arcs and iss.wresl_value:
                        gn.arcs[iss.feature_id].to_node = iss.wresl_value
                        n_to += 1
                print(f"  Topology fixes: {n_from} from_node, {n_to} to_node patched.")

            # Annotate nodes with arc variables that the solver references but
            # have no geometry in the GeoSchematic.
            no_geo_ids = {i.feature_id for i in report.by_kind("arc_no_geo")}
            for arc_id in no_geo_ids:
                for node_id in {report.wresl_from.get(arc_id),
                                report.wresl_to.get(arc_id)}:
                    if node_id and node_id in gn.nodes:
                        if arc_id not in gn.nodes[node_id].missing_arcs:
                            gn.nodes[node_id].missing_arcs.append(arc_id)

            # Annotate geo arcs with their probable WRESL counterpart when
            # the two differ only in downstream node label (arc_endpoint_suggestion).
            for geo_arc_id, wresl_arc_id in report.arc_suggestions.items():
                if geo_arc_id in gn.arcs:
                    gn.arcs[geo_arc_id].wresl_suggestion = wresl_arc_id

            # Rebuild GeoJSON to include solver_active, patched topology, and
            # missing_arcs / wresl_suggestion annotations.
            rebuild_geojson(gn)

    # -----------------------------------------------------------------------
    # 3. Write output artifacts
    # -----------------------------------------------------------------------

    # catalog.json
    catalog = {
        "nodes": {cs3_id: node.to_dict() for cs3_id, node in gn.nodes.items()},
        "arcs": {arc_id: arc.to_dict() for arc_id, arc in gn.arcs.items()},
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

    # -----------------------------------------------------------------------
    # 4. Print diagnostics summary
    # -----------------------------------------------------------------------
    if report is not None:
        print(f"\n{report.summary()}")
        diag_path = out / "network_diagnostics.json"
        diag_path.write_text(
            json.dumps(report.to_dict(), indent=2), encoding="utf-8"
        )
        print(f"  Diagnostics written to: {diag_path}")


if __name__ == "__main__":
    main()
