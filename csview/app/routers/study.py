"""
Study API router — serves pre-built Parquet study results.
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, Query

from csview.app.schemas import (
    FeatureResultSeries,
    StudyInfo,
    StudyListResponse,
)
from csview.app.state import AppState, get_state
from csview.study.store import StudyStore

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
    return [
        [str(idx.date()), float(val)]
        for idx, val in series.items()
        if pd.notna(val)
    ]


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
    """Return all monthly time series for *feature_id* from the specified study."""
    store = _resolve_study(state, study)
    series_map = store.get_feature_series(feature_id)

    if not series_map:
        raise HTTPException(
            status_code=404,
            detail=f"No results found for feature '{feature_id}' in study '{store.name}'",
        )

    series_out: Dict[str, List[List]] = {}
    meta_out: Dict[str, dict] = {}
    for var, s in series_map.items():
        series_out[var] = _series_to_rows(s)
        meta_out[var] = store.get_variable_meta(var)

    return FeatureResultSeries(
        feature_id=feature_id,
        study=store.name,
        series=series_out,
        metadata=meta_out,
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
