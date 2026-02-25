"""
Network API router — serves CalSim GeoSchematic network (nodes, arcs, GeoJSON).
"""

from __future__ import annotations

from typing import List, Optional, Union

from fastapi import APIRouter, Depends, HTTPException, Query

from csview.app.schemas import (
    ArcDetail,
    FeatureSummary,
    NeighborhoodArc,
    NeighborhoodNode,
    NeighborhoodResponse,
    NodeDetail,
)
from csview.app.state import AppState, get_state
from csview.geo.models import GeoArc, GeoNode

router = APIRouter()


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------

def _node_summary(n: GeoNode) -> FeatureSummary:
    return FeatureSummary(
        feature_id=n.cs3_id,
        feature_kind="node",
        hydro_region=n.hydro_region or None,
        description=n.description or None,
        name=n.river_name or None,
        node_type=n.node_type or None,
        arc_type=None,
        units=None,
        lon=n.lon,
        lat=n.lat,
    )


def _arc_summary(a: GeoArc) -> FeatureSummary:
    return FeatureSummary(
        feature_id=a.arc_id,
        feature_kind="arc",
        hydro_region=a.hydro_region or None,
        description=a.description or None,
        name=a.name or None,
        node_type=None,
        arc_type=a.arc_type or None,
        units=a.units or None,
        lon=None,
        lat=None,
    )


def _node_detail(n: GeoNode) -> NodeDetail:
    return NodeDetail(
        feature_id=n.cs3_id,
        cs3_id=n.cs3_id,
        description=n.description or None,
        node_type=n.node_type or None,
        hydro_region=n.hydro_region or None,
        river_name=n.river_name or None,
        nearest_gage=n.nearest_gage or None,
        stream_code=n.stream_code or None,
        river_mile=n.river_mile or None,
        calsim2_id=n.calsim2_id or None,
        lon=n.lon,
        lat=n.lat,
        dss_variables=list(n.dss_variables),
    )


def _arc_detail(a: GeoArc) -> ArcDetail:
    return ArcDetail(
        feature_id=a.arc_id,
        arc_id=a.arc_id,
        name=a.name or None,
        arc_type=a.arc_type or None,
        sub_type=a.sub_type or None,
        from_node=a.from_node or None,
        to_node=a.to_node or None,
        hydro_region=a.hydro_region or None,
        description=a.description or None,
        units=a.units or None,
        kind=a.kind or None,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("", summary="Full network as GeoJSON FeatureCollection")
def get_network(state: AppState = Depends(get_state)) -> dict:
    """Return all arcs and nodes as a merged GeoJSON FeatureCollection."""
    if state.network is None:
        return {"type": "FeatureCollection", "features": []}
    return state.network.geojson


@router.get("/features", response_model=List[FeatureSummary], summary="List all features")
def list_features(
    feature_kind: Optional[str] = Query(default=None, description="'node' or 'arc'"),
    hydro_region: Optional[str] = Query(default=None, description="Filter by hydro region"),
    node_type: Optional[str] = Query(default=None, description="Filter nodes by type"),
    arc_type: Optional[str] = Query(default=None, description="Filter arcs by type"),
    state: AppState = Depends(get_state),
) -> List[FeatureSummary]:
    """Return summary metadata for every GeoSchematic feature."""
    if state.network is None:
        return []
    results = []
    if feature_kind != "arc":
        for n in state.network.nodes.values():
            if hydro_region and n.hydro_region != hydro_region:
                continue
            if node_type and n.node_type != node_type:
                continue
            results.append(_node_summary(n))
    if feature_kind != "node":
        for a in state.network.arcs.values():
            if hydro_region and a.hydro_region != hydro_region:
                continue
            if arc_type and a.arc_type != arc_type:
                continue
            results.append(_arc_summary(a))
    return results


@router.get(
    "/features/{feature_id}",
    summary="Detail for a single node or arc",
)
def get_feature(
    feature_id: str,
    state: AppState = Depends(get_state),
) -> Union[NodeDetail, ArcDetail]:
    """Return full details for a feature looked up by feature_id."""
    if state.network is None:
        raise HTTPException(status_code=503, detail="Network not loaded")
    fid = feature_id.upper()
    node = state.network.lookup_node(fid)
    if node:
        return _node_detail(node)
    arc = state.network.lookup_arc(fid)
    if arc:
        return _arc_detail(arc)
    raise HTTPException(status_code=404, detail=f"Feature '{feature_id}' not found")


@router.get(
    "/features/{feature_id}/neighborhood",
    response_model=NeighborhoodResponse,
    summary="BFS neighborhood subgraph around a node",
)
def get_neighborhood(
    feature_id: str,
    depth: int = Query(default=2, ge=1, le=5, description="BFS depth"),
    state: AppState = Depends(get_state),
) -> NeighborhoodResponse:
    """Return nodes and arcs within *depth* hops of *feature_id* (nodes only as BFS anchors)."""
    if state.network is None:
        raise HTTPException(status_code=503, detail="Network not loaded")

    fid = feature_id.upper()
    # Resolve: could be called with either a node id or an arc id
    start_node = state.network.lookup_node(fid)
    if start_node is None:
        # If it's an arc, anchor on from_node — or to_node for inflow arcs that have no from_node
        arc = state.network.lookup_arc(fid)
        if arc:
            anchor = arc.from_node or arc.to_node
            if anchor:
                start_node = state.network.lookup_node(anchor.upper())
    if start_node is None:
        raise HTTPException(status_code=404, detail=f"Feature '{feature_id}' not found")

    start_id = start_node.cs3_id.upper()

    # Build adjacency from arc topology
    out_arcs: dict = {}   # node_id → [arcs where from_node == node_id]
    in_arcs: dict = {}    # node_id → [arcs where to_node == node_id]
    for arc in state.network.arcs.values():
        fn = (arc.from_node or "").upper()
        tn = (arc.to_node or "").upper()
        if fn:
            out_arcs.setdefault(fn, []).append(arc)
        if tn:
            in_arcs.setdefault(tn, []).append(arc)

    # BFS
    visited_nodes: dict = {start_id: 0}
    visited_arcs: set = set()
    frontier = {start_id}

    for step in range(1, depth + 1):
        next_frontier: set = set()
        for nid in frontier:
            for arc in out_arcs.get(nid, []):
                visited_arcs.add(arc.arc_id.upper())
                tn = (arc.to_node or "").upper()
                if tn and tn not in visited_nodes:
                    visited_nodes[tn] = step
                    next_frontier.add(tn)
            for arc in in_arcs.get(nid, []):
                visited_arcs.add(arc.arc_id.upper())
                fn = (arc.from_node or "").upper()
                if fn and fn not in visited_nodes:
                    visited_nodes[fn] = -step
                    next_frontier.add(fn)
        frontier = next_frontier

    gn = state.network

    # Build a set of node IDs that actually have GeoNode entries (have positions).
    # Phantom zone nodes ("02"/"03") may appear in visited_nodes as BFS stepping
    # stones but have no GeoNode; they must be excluded from both nodes and arcs.
    rendered_node_ids = {nid for nid in visited_nodes if gn.lookup_node(nid) is not None}

    arcs_out = []
    for arc_id in visited_arcs:
        arc = gn.lookup_arc(arc_id)
        if arc is None:
            continue
        fn = (arc.from_node or "").upper()
        tn = (arc.to_node or "").upper()
        # Include arc when every non-empty endpoint is a rendered node.
        # Arcs with a missing from_node (e.g. Inflow) or missing to_node are
        # boundary arcs and are shown as long as the present endpoint is rendered.
        fn_ok = (not fn) or (fn in rendered_node_ids)
        tn_ok = (not tn) or (tn in rendered_node_ids)
        if fn_ok and tn_ok and (fn or tn):
            arcs_out.append(NeighborhoodArc(
                feature_id=arc.arc_id,
                from_node=arc.from_node or "",
                to_node=arc.to_node or "",
            ))

    # Only emit nodes that are actually connected by an arc in arcs_out, plus
    # the BFS start node itself.  This prevents phantom-node stepping stones
    # from carrying unreachable real nodes into the output.
    connected_node_ids: set = {start_id}
    for a in arcs_out:
        if a.from_node:
            connected_node_ids.add(a.from_node.upper())
        if a.to_node:
            connected_node_ids.add(a.to_node.upper())

    nodes_out = []
    for nid, dist in visited_nodes.items():
        if nid not in connected_node_ids:
            continue
        n = gn.lookup_node(nid)
        if n is None:
            continue
        nodes_out.append(NeighborhoodNode(
            feature_id=n.cs3_id,
            feature_kind="node",
            node_type=n.node_type or None,
            description=n.description or None,
            distance=dist,
        ))

    return NeighborhoodResponse(nodes=nodes_out, arcs=arcs_out)


@router.get("/regions", response_model=List[str], summary="List hydro regions")
def list_regions(state: AppState = Depends(get_state)) -> List[str]:
    if state.network is None:
        return []
    return sorted(state.network.hydro_regions())


@router.get("/types", response_model=List[str], summary="List distinct node types")
def list_node_types(state: AppState = Depends(get_state)) -> List[str]:
    if state.network is None:
        return []
    return sorted(state.network.feature_types().get("node_types", []))


@router.get("/arc-types", response_model=List[str], summary="List distinct arc types")
def list_arc_types(state: AppState = Depends(get_state)) -> List[str]:
    if state.network is None:
        return []
    return sorted(state.network.feature_types().get("arc_types", []))


@router.get("/overlays/{layer}", summary="Overlay GeoJSON (watersheds, water_budget, demand_unit)")
def get_overlay(layer: str, state: AppState = Depends(get_state)) -> dict:
    if state.network is None:
        raise HTTPException(status_code=503, detail="Network not loaded")
    mapping = {
        "watersheds": state.network.watersheds_geojson,
        "water_budget": state.network.water_budget_geojson,
        "demand_unit": state.network.demand_unit_geojson,
    }
    data = mapping.get(layer)
    if data is None:
        raise HTTPException(
            status_code=404,
            detail=f"Layer '{layer}' not found. Available: {list(mapping.keys())}",
        )
    return data
