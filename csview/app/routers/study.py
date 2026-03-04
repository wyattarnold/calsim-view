"""
Study API router — serves pre-built Parquet study results.
"""

from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query

from csview.app.schemas import (
    FeatureResultSeries,
    GwBudgetResponse,
    GwBudgetMeta,
    StudyInfo,
    StudyListResponse,
)
from csview.app.state import AppState, get_state
from csview.study.store import StudyStore, GwBudgetStore

logger = logging.getLogger(__name__)
router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _study_info(store: StudyStore, active_name: Optional[str]) -> StudyInfo:
    date_start, date_end = store.date_range
    return StudyInfo(
        name=store.name,
        path=str(store.study_dir),
        variables_count=len(store.variables),
        date_start=date_start,
        date_end=date_end,
        active=(store.name == active_name),
    )


def _resolve_study(state: AppState, name: Optional[str]) -> StudyStore:
    s = state.get_study(name)
    if s is None:
        label = f"'{name}'" if name else "active study"
        raise HTTPException(status_code=404, detail=f"Study {label} not found")
    return s


def _series_to_rows(series: pd.Series) -> List[List]:
    """Convert a pandas Series with DatetimeIndex to [[date_str, value], ...].

    Uses vectorised strftime + tolist for speed (~2.5× faster than a Python
    comprehension over .items()).
    """
    s = series.dropna()
    if s.empty:
        return []
    dates = s.index.strftime("%Y-%m-%d").tolist()
    vals = s.values.tolist()
    return [list(pair) for pair in zip(dates, vals)]


def _collect_arc_series(
    node_cs3_id: str,
    network: "GeoNetwork",
    store: StudyStore,
    series_out: Dict[str, List[List]],
    meta_out: Dict[str, dict],
) -> None:
    """Append connected-arc time series for a node into *series_out*/*meta_out*.

    Connected geo arcs (and their ``wresl_suggestion`` fallbacks) are
    batch-read in a single Parquet I/O pass via
    :meth:`StudyStore.get_multi_feature_series`.  WRESL-only ``missing_arcs``
    are handled in a second batch.
    """
    upper_id = node_cs3_id.upper()

    # --- Phase 1: identify connected geo arcs + direction ---
    connected: List[tuple] = []   # (GeoArc, direction)
    for arc in network.arcs.values():
        from_n = (arc.from_node or "").upper()
        to_n   = (arc.to_node   or "").upper()
        if from_n != upper_id and to_n != upper_id:
            continue
        direction = "out" if from_n == upper_id else "in"
        connected.append((arc, direction))

    # --- Phase 2: batch-read all connected arcs in one I/O ---
    fids_to_read: List[str] = []
    fid_direction: Dict[str, str] = {}
    for arc, direction in connected:
        fids_to_read.append(arc.arc_id)
        fid_direction[arc.arc_id] = direction
        if arc.wresl_suggestion:
            fids_to_read.append(arc.wresl_suggestion)
            fid_direction.setdefault(arc.wresl_suggestion, direction)

    multi = store.get_multi_feature_series(fids_to_read)

    for arc, direction in connected:
        arc_series_map = multi.get(arc.arc_id, {})
        if not arc_series_map and arc.wresl_suggestion:
            arc_series_map = multi.get(arc.wresl_suggestion, {})
        if not arc_series_map:
            continue
        for var, arc_series in arc_series_map.items():
            arc_meta = dict(store.get_variable_meta(var))
            arc_meta["direction"] = direction
            series_out[var] = _series_to_rows(arc_series)
            meta_out[var]   = arc_meta

    # --- Phase 3: missing arcs (WRESL-only, no GeoSchematic geometry) ---
    _ARC_PREFIXES = ("C_", "E_", "I_", "D_", "F_", "R_", "S_")
    _DELIVERY_PREFIXES = ("D_", "R_", "RP_", "RU_", "F_")
    geo_node_ids = set(n.upper() for n in network.nodes)
    global_arc_conn = getattr(network, "arc_connectivity", {})
    node = network.lookup_node(node_cs3_id)
    if node is not None:
        missing_ids = [a for a in (node.missing_arcs or []) if a not in series_out]
        if missing_ids:
            missing_multi = store.get_multi_feature_series(missing_ids)
            for arc_id in missing_ids:
                if arc_id in series_out:
                    continue
                arc_upper = arc_id.upper()
                direction = global_arc_conn.get(arc_upper)
                if direction is None:
                    direction = "out" if arc_upper.startswith(_DELIVERY_PREFIXES) else "in"
                arc_series_map = missing_multi.get(arc_id, {})
                if arc_series_map:
                    for var, arc_series in arc_series_map.items():
                        arc_meta = dict(store.get_variable_meta(var))
                        arc_meta["direction"] = direction
                        series_out[var] = _series_to_rows(arc_series)
                        meta_out[var]   = arc_meta
                    continue
                # No DSS data — try proxy through phantom node.
                phantom = None
                for pfx in _ARC_PREFIXES:
                    if arc_upper.startswith(pfx):
                        phantom = arc_upper[len(pfx):]
                        break
                if not phantom or phantom == upper_id or phantom in geo_node_ids:
                    continue
                for geo_arc in network.arcs.values():
                    if (geo_arc.to_node or "").upper() != phantom:
                        continue
                    proxy_data = store.get_feature_series(geo_arc.arc_id)
                    if not proxy_data:
                        continue
                    for var, s in proxy_data.items():
                        if var in series_out:
                            continue
                        proxy_meta = dict(store.get_variable_meta(var))
                        proxy_meta["direction"] = "in"
                        series_out[var] = _series_to_rows(s)
                        meta_out[var]   = proxy_meta


def _try_wresl_suggestion(
    feature_id: str,
    network: "GeoNetwork",
    store: StudyStore,
) -> tuple:
    """Try the wresl_suggestion fallback for an arc with no direct data.

    Returns ``(series_out, meta_out, suggestion_used)`` — all empty if no
    suggestion produces data.
    """
    if network is None:
        return {}, {}, None
    arc = network.lookup_arc(feature_id)
    if arc is None or not arc.wresl_suggestion:
        return {}, {}, None
    sugg_series = store.get_feature_series(arc.wresl_suggestion)
    if not sugg_series:
        return {}, {}, None
    series_out: Dict[str, List[List]] = {}
    meta_out: Dict[str, dict] = {}
    for var, s in sugg_series.items():
        series_out[var] = _series_to_rows(s)
        meta_out[var] = store.get_variable_meta(var)
    return series_out, meta_out, arc.wresl_suggestion


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/studies", response_model=StudyListResponse, summary="List all studies")
def list_studies(state: AppState = Depends(get_state)) -> StudyListResponse:
    """Return metadata for all registered study stores."""
    return StudyListResponse(
        studies=[_study_info(s, state.active_study) for s in state.iter_studies()],
        active=state.active_study,
    )


@router.post("/studies/{name}/activate", summary="Set the active study")
def activate_study(name: str, state: AppState = Depends(get_state)) -> dict:
    try:
        state.set_active_study(name)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    return {"active": name}


@router.get(
    "/studies/{name}/variables",
    response_model=List[str],
    summary="List variables in a study Parquet",
)
def list_variables(name: str, state: AppState = Depends(get_state)) -> List[str]:
    store = _resolve_study(state, name)
    return store.variables


@router.get(
    "/feature/{feature_id}",
    response_model=FeatureResultSeries,
    summary="Time series for a GeoSchematic feature",
)
def get_feature_result(
    feature_id: str,
    study: Optional[str] = Query(default=None, description="Study name; defaults to active"),
    state: AppState = Depends(get_state),
) -> FeatureResultSeries:
    """Return all monthly time series for *feature_id* from the specified study.

    For node features, connected arc series are included with a ``direction``
    field (``"in"`` or ``"out"``) in their metadata so the frontend can render
    a separate Arc Flows chart without needing a second request.
    """
    store = _resolve_study(state, study)
    series_map = store.get_feature_series(feature_id)

    series_out: Dict[str, List[List]] = {}
    meta_out: Dict[str, dict] = {}
    for var, s in series_map.items():
        series_out[var] = _series_to_rows(s)
        meta_out[var] = store.get_variable_meta(var)

    # For node features, also include connected arc series with direction.
    network = state.network
    if network is not None:
        node = network.lookup_node(feature_id)
        if node is not None:
            _collect_arc_series(node.cs3_id, network, store, series_out, meta_out)
            # Tag E_ (evaporation) node variables as outflows so they appear
            # in the Arc Flows chart rather than the water balance.
            for var in list(meta_out.keys()):
                if var.upper().startswith("E_") and "direction" not in meta_out[var]:
                    meta_out[var] = dict(meta_out[var], direction="out")

            # Tag SG_ seepage node variables with direction derived from the
            # WRESL constraints-Connectivity equations (stored in catalog.json
            # as node.inflow_arcs / node.outflow_arcs).  This is authoritative
            # for both geo arcs and phantom/no-geo SG arcs.
            _SG_RE = re.compile(r'^SG\d+_', re.IGNORECASE)
            node_inflow_set  = {a.upper() for a in (node.inflow_arcs  or [])}
            node_outflow_set = {a.upper() for a in (node.outflow_arcs or [])}
            global_arc_conn  = getattr(network, 'arc_connectivity', {})
            for var in list(meta_out.keys()):
                if _SG_RE.match(var) and "direction" not in meta_out[var]:
                    var_upper = var.upper()
                    if var_upper in node_inflow_set:
                        direction = "in"
                    elif var_upper in node_outflow_set:
                        direction = "out"
                    else:
                        # SG variable from a different node's equation (e.g.
                        # SG455_CWD009_77 in CWD013's eq, a non-geo node).
                        # Fall back to the global arc-connectivity index.
                        direction = global_arc_conn.get(var_upper)
                    if direction:
                        meta_out[var] = dict(meta_out[var], direction=direction)

    if series_out:
        return FeatureResultSeries(
            feature_id=feature_id,
            study=store.name,
            series=series_out,
            metadata=meta_out,
        )

    # Fallback: try wresl_suggestion for arcs with no direct data
    sugg_series, sugg_meta, suggestion_used = _try_wresl_suggestion(
        feature_id, network, store,
    )
    if sugg_series:
        return FeatureResultSeries(
            feature_id=feature_id,
            study=store.name,
            series=sugg_series,
            metadata=sugg_meta,
            wresl_suggestion_used=suggestion_used,
        )

    raise HTTPException(
        status_code=404,
        detail=f"No results found for feature '{feature_id}' in study '{store.name}'",
    )


@router.get(
    "/variable/{prmname}",
    response_model=FeatureResultSeries,
    summary="Time series for a specific DSS variable name",
)
def get_variable_result(
    prmname: str,
    study: Optional[str] = Query(default=None, description="Study name; defaults to active"),
    state: AppState = Depends(get_state),
) -> FeatureResultSeries:
    """Return the time series for a specific DSS variable (e.g. S_SHSTA, C_FOLSM)."""
    store = _resolve_study(state, study)
    series = store.get_series(prmname)

    if series is None:
        raise HTTPException(
            status_code=404,
            detail=f"Variable '{prmname}' not found in study '{store.name}'",
        )

    meta = store.get_variable_meta(prmname)
    feature_id = meta.get("feature_id", prmname)

    return FeatureResultSeries(
        feature_id=feature_id,
        study=store.name,
        series={prmname: _series_to_rows(series)},
        metadata={prmname: meta},
    )


# ---------------------------------------------------------------------------
# GW Budget endpoints
# ---------------------------------------------------------------------------

@router.get(
    "/gw_budget/meta",
    response_model=GwBudgetMeta,
    summary="GW budget metadata (available WBAs, C-parts, units)",
)
def gw_budget_meta(
    study: Optional[str] = Query(default=None),
    state: AppState = Depends(get_state),
) -> GwBudgetMeta:
    """Return metadata about the groundwater budget dataset."""
    gw = state.get_gw_budget(study)
    if gw is None:
        raise HTTPException(status_code=404, detail="No GW budget data available")
    return GwBudgetMeta(
        available=True,
        wba_ids=gw.wba_ids,
        wba_ids_with_polygon=gw.wba_ids_with_polygon,
        c_parts=gw.c_parts,
        c_part_labels=gw.c_part_labels,
        units=gw.units,
    )


@router.get(
    "/gw_budget/{wba_id}",
    response_model=GwBudgetResponse,
    summary="GW budget time series for a Water Budget Area",
)
def get_gw_budget(
    wba_id: str,
    study: Optional[str] = Query(default=None),
    state: AppState = Depends(get_state),
) -> GwBudgetResponse:
    """Return all groundwater budget component series for *wba_id*."""
    gw = state.get_gw_budget(study)
    if gw is None:
        raise HTTPException(status_code=404, detail="No GW budget data available")

    budget = gw.get_wba_budget(wba_id)
    if not budget:
        raise HTTPException(
            status_code=404,
            detail=f"No GW budget data for WBA '{wba_id}'",
        )

    series_out: Dict[str, List[List]] = {}
    for c_part, s in budget.items():
        series_out[c_part] = _series_to_rows(s)

    return GwBudgetResponse(
        wba_id=wba_id,
        units=gw.units,
        c_part_labels=gw.c_part_labels,
        series=series_out,
    )
