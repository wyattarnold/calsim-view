"""
Pydantic response models for the CalSim View API.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Network — feature summaries (nodes + arcs unified)
# ---------------------------------------------------------------------------

class FeatureSummary(BaseModel):
    feature_id: str
    feature_kind: str          # "node" | "arc"
    hydro_region: Optional[str]
    description: Optional[str]
    name: Optional[str]        # arc name / river name
    node_type: Optional[str]   # node only: "Reservoir", "Junction", etc.
    arc_type: Optional[str]    # arc only: "Channel", "Diversion", etc.
    units: Optional[str]
    lon: Optional[float]       # node only
    lat: Optional[float]       # node only


class NodeDetail(BaseModel):
    feature_id: str
    feature_kind: str = "node"
    cs3_id: str
    description: Optional[str]
    node_type: Optional[str]
    hydro_region: Optional[str]
    river_name: Optional[str]
    nearest_gage: Optional[str]
    stream_code: Optional[str]
    river_mile: Optional[float]
    calsim2_id: Optional[str]
    lon: float
    lat: float
    dss_variables: List[str] = []
    missing_arcs: List[str] = []


class ArcDetail(BaseModel):
    feature_id: str
    feature_kind: str = "arc"
    arc_id: str
    name: Optional[str]
    arc_type: Optional[str]
    sub_type: Optional[str]
    from_node: Optional[str]
    to_node: Optional[str]
    hydro_region: Optional[str]
    description: Optional[str]
    units: Optional[str]
    kind: Optional[str]
    capacity_cfs: Optional[float] = None
    solver_active: bool = True
    wresl_suggestion: Optional[str] = None


# ---------------------------------------------------------------------------
# Neighborhood subgraph
# ---------------------------------------------------------------------------

class NeighborhoodNode(BaseModel):
    feature_id: str
    feature_kind: str
    node_type: Optional[str]
    description: Optional[str]
    distance: int


class NeighborhoodArc(BaseModel):
    feature_id: str
    from_node: str
    to_node: str


class NeighborhoodResponse(BaseModel):
    nodes: List[NeighborhoodNode]
    arcs: List[NeighborhoodArc]


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

class StudyInfo(BaseModel):
    name: str
    path: str
    variables_count: int
    date_start: Optional[str]
    date_end: Optional[str]
    active: bool


class StudyListResponse(BaseModel):
    studies: List[StudyInfo]
    active: Optional[str]


class FeatureResultSeries(BaseModel):
    """Monthly time series result for a GeoSchematic feature.

    ``series`` is keyed by DSS variable name (e.g. "S_SHSTA", "C_FOLSM").
    Each value is a list of ``[ISO-date-str, float]`` rows.
    ``metadata`` holds per-variable units/kind/c_part.
    """
    feature_id: str
    study: str
    series: Dict[str, List[List]]          # {prmname: [[date, val], ...]}
    metadata: Dict[str, Dict[str, Any]]    # {prmname: {units, kind, c_part, ...}}
    # Set when results belong to a suggested WRESL counterpart arc rather than
    # the requested feature directly (arc_endpoint_suggestion diagnostic match).
    wresl_suggestion_used: Optional[str] = None
