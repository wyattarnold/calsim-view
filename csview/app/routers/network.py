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
from csview.geo.models import GeoArc, GeoNetwork, GeoNode

router = APIRouter()


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
            results.append(FeatureSummary.from_node(n))
    if feature_kind != "node":
        for a in state.network.arcs.values():
            if hydro_region and a.hydro_region != hydro_region:
                continue
            if arc_type and a.arc_type != arc_type:
                continue
            results.append(FeatureSummary.from_arc(a))
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
        return NodeDetail.from_geo(node)
    arc = state.network.lookup_arc(fid)
    if arc:
        return ArcDetail.from_geo(arc)
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

    nodes_out, arcs_out = _bfs_subgraph(state.network, start_node.cs3_id.upper(), depth)
    return NeighborhoodResponse(nodes=nodes_out, arcs=arcs_out)


def _bfs_subgraph(
    gn: GeoNetwork,
    start_id: str,
    depth: int,
) -> tuple:
    """Pure-logic BFS returning ``(nodes, arcs)`` for the neighborhood.

    Walks outflow and inflow arcs up to *depth* hops from *start_id*,
    filtering out phantom zone nodes that have no :class:`GeoNode` entry.
    """
    # Build adjacency from arc topology
    out_arcs: dict = {}   # node_id → [arcs where from_node == node_id]
    in_arcs: dict = {}    # node_id → [arcs where to_node == node_id]
    for arc in gn.arcs.values():
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

    return nodes_out, arcs_out


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
