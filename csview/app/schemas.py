"""
Pydantic response models for the CalSim View API.
"""

from __future__ import annotations

import re
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

    @classmethod
    def from_node(cls, n: "GeoNode") -> "FeatureSummary":
        return cls(
            feature_id=n.cs3_id, feature_kind="node",
            hydro_region=n.hydro_region or None, description=n.description or None,
            name=n.river_name or None, node_type=n.node_type or None,
            arc_type=None, units=None, lon=n.lon, lat=n.lat,
        )

    @classmethod
    def from_arc(cls, a: "GeoArc") -> "FeatureSummary":
        return cls(
            feature_id=a.arc_id, feature_kind="arc",
            hydro_region=a.hydro_region or None, description=a.description or None,
            name=a.name or None, node_type=None,
            arc_type=a.arc_type or None, units=a.units or None,
            lon=None, lat=None,
        )


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
    solver_active: bool = True
    dss_variables: List[str] = []
    missing_arcs: List[str] = []
    seepage_vars: List[str] = []

    @classmethod
    def from_geo(cls, n: "GeoNode") -> "NodeDetail":
        return cls(
            feature_id=n.cs3_id, cs3_id=n.cs3_id,
            description=n.description or None, node_type=n.node_type or None,
            hydro_region=n.hydro_region or None, river_name=n.river_name or None,
            nearest_gage=n.nearest_gage or None, stream_code=n.stream_code or None,
            river_mile=n.river_mile or None, calsim2_id=n.calsim2_id or None,
            lon=n.lon, lat=n.lat,
            solver_active=bool(n.dss_variables) or bool(n.missing_arcs) or bool(n.inflow_arcs) or bool(n.outflow_arcs),
            dss_variables=list(n.dss_variables), missing_arcs=list(n.missing_arcs),
            seepage_vars=[v for v in n.dss_variables if re.match(r'^SG\d+_', v, re.IGNORECASE)],
        )


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

    @classmethod
    def from_geo(cls, a: "GeoArc") -> "ArcDetail":
        return cls(
            feature_id=a.arc_id, arc_id=a.arc_id,
            name=a.name or None, arc_type=a.arc_type or None,
            sub_type=a.sub_type or None, from_node=a.from_node or None,
            to_node=a.to_node or None, hydro_region=a.hydro_region or None,
            description=a.description or None, units=a.units or None,
            kind=a.kind or None, capacity_cfs=a.capacity_cfs,
            solver_active=a.solver_active, wresl_suggestion=a.wresl_suggestion,
        )


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


# ---------------------------------------------------------------------------
# GW Budget
# ---------------------------------------------------------------------------

class GwBudgetMeta(BaseModel):
    """Metadata about available groundwater budget data."""
    available: bool
    wba_ids: List[str]
    wba_ids_with_polygon: List[str]
    c_parts: List[str]
    c_part_labels: Dict[str, str]
    units: str


class GwBudgetResponse(BaseModel):
    """Groundwater budget time series for one Water Budget Area.

    ``series`` is keyed by C-part name (e.g. "PUMPING", "NET_DEEP_PERC").
    Each value is a list of ``[ISO-date-str, float]`` rows.
    """
    wba_id: str
    units: str
    c_part_labels: Dict[str, str]
    series: Dict[str, List[List]]
