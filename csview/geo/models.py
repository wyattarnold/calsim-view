"""
Data classes for the GeoSchematic-based CalSim 3 network.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# Node type inference from NodeDescription text
# ---------------------------------------------------------------------------

def node_type_from_description(description: str) -> str:
    """Derive a concise node-type category from the NodeDescription field."""
    d = (description or "").lower().strip()
    # Check groundwater combinations BEFORE generic storage so that
    # "groundwater storage" nodes are not misclassified as Reservoir.
    if "groundwater" in d and "storage" in d:
        return "Groundwater Storage"
    if "groundwater" in d:
        return "Groundwater"
    if "storage" in d or "reservoir" in d or "lake" in d:
        return "Reservoir"
    if "demand-agricultural" in d:
        return "Demand-Agricultural"
    if "demand-urban" in d or "water treatment" in d:
        return "Demand-Urban"
    if "demand-refuge" in d:
        return "Demand-Refuge"
    if "return flow" in d or "wastewater" in d:
        return "Return Flow"
    if "conveyance" in d or "channel" in d or "canal" in d:
        return "Junction"
    if "external" in d or "major feature" in d:
        return "Boundary"
    return "Other"


# ---------------------------------------------------------------------------
# Arc type normalisation from the GeoSchematic Type field
# ---------------------------------------------------------------------------

ARC_TYPE_MAP: Dict[str, str] = {
    "Channel":              "Channel",
    "Diversion":            "Diversion",
    "Diverison":            "Diversion",   # typo present in source data
    "Return":               "Return Flow",
    "Inflow":               "Inflow",
    "Seepage":              "Seepage",
    "Surface Runoff":       "Surface Runoff",
    "Tile Drain to Stream": "Tile Drain",
    "Evaporation":          "Evaporation",
    "Closure Term":         "Closure Term",
    "Spill":                "Spill",
    "Delta Accretion":      "Delta Accretion",
    "Delta Depletion":      "Delta Depletion",
}


# ---------------------------------------------------------------------------
# Units lookup from WRESL kind (fallback when WRESL join is not run)
# ---------------------------------------------------------------------------

KIND_TO_UNITS: Dict[str, str] = {
    "STORAGE":          "TAF",
    "STORAGE-ZONE":     "TAF",
    "EVAPORATION":      "TAF",
    "SURFACE-AREA":     "ACRES",
    "CHANNEL":          "CFS",
    "DIVERSION":        "CFS",
    "FLOW":             "CFS",
    "ADD-FLOW":         "CFS",
    "INFLOW":           "CFS",
    "DELIVERY":         "CFS",
    "AG-DELIVERY":      "CFS",
    "URBAN-DELIVERY":   "CFS",
    "URBAN-DEMAND":     "CFS",
    "SHORTAGE":         "CFS",
    "RETURN-FLOW":      "CFS",
    "SEEPAGE":          "CFS",
    "GROUNDWATER":      "TAF",
    "GW-STORAGE":       "TAF",
    "GROUNDWATER-FLOW": "CFS",
}

# Arc-type → typical units (used when neither WRESL nor DSS C-part available)
ARC_TYPE_TO_UNITS: Dict[str, str] = {
    "Channel":      "CFS",
    "Diversion":    "CFS",
    "Return Flow":  "CFS",
    "Inflow":       "CFS",
    "Seepage":      "CFS",
    "Surface Runoff": "CFS",
    "Tile Drain":   "CFS",
    "Evaporation":  "TAF",
    "Spill":        "CFS",
}


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class GeoNode:
    """A CalSim 3 network node from the Geographic Schematic."""

    cs3_id: str                      # e.g. "SHSTA", "EMD001"
    description: str                 # NodeDescription (e.g. "storage- reservoir or lake")
    node_type: str                   # Derived type category (e.g. "Reservoir", "Junction")
    lon: float
    lat: float
    hydro_region: str                # e.g. "SAC", "SJR", "Delta"
    river_name: str
    nearest_gage: str
    stream_code: str
    river_mile: Optional[float]
    c2vsim_gw: str
    c2vsim_sw: str
    calsim2_id: str

    # Populated when results are built: DSS variables that map to this node.
    # e.g. for node "SHSTA": ["S_SHSTA", "E_SHSTA", "A_SHSTA"]
    dss_variables: List[str] = field(default_factory=list)


@dataclass
class GeoArc:
    """A CalSim 3 arc from the Geographic Schematic.

    ``arc_id`` is the authoritative identifier and directly corresponds to the
    CalSim DSS variable name (e.g. "C_FOLSM", "I_DRC012").
    """

    arc_id: str                      # = DSS variable name, e.g. "C_FOLSM"
    name: str                        # Natural name (e.g. "American River at Folsom")
    arc_type: str                    # Normalised type (e.g. "Channel", "Diversion")
    sub_type: str                    # e.g. "Stream", "Canal"
    from_node: Optional[str]         # cs3_id of upstream node
    to_node: Optional[str]           # cs3_id of downstream node
    hydro_region: str
    description: str
    coordinates: List[List[float]]   # [[lon, lat], ...]  — full or simplified

    # Populated from WRESL join
    units: Optional[str] = None
    kind: Optional[str] = None       # WRESL kind string, e.g. "CHANNEL"

    @property
    def default_units(self) -> str:
        """Best-guess units when explicit metadata is missing."""
        if self.units:
            return self.units
        return ARC_TYPE_TO_UNITS.get(self.arc_type, "CFS")


@dataclass
class GeoNetwork:
    """Complete CalSim 3 network loaded from the Geographic Schematic."""

    # Primary indexes
    nodes: Dict[str, GeoNode] = field(default_factory=dict)   # cs3_id.upper() → GeoNode
    arcs: Dict[str, GeoArc] = field(default_factory=dict)      # arc_id.upper() → GeoArc

    # Pre-built GeoJSON FeatureCollection
    geojson: Dict[str, Any] = field(default_factory=dict)

    # Reverse index: DSS variable name (upper) → cs3_id
    # Populated when results are built (or via WRESL catalog).
    variable_to_node: Dict[str, str] = field(default_factory=dict)

    # Overlay layers (pass-through GeoJSON, loaded at build time)
    watersheds_geojson: Dict[str, Any] = field(default_factory=dict)
    water_budget_geojson: Dict[str, Any] = field(default_factory=dict)
    demand_unit_geojson: Dict[str, Any] = field(default_factory=dict)

    # -----------------------------------------------------------------------
    # Lookup helpers
    # -----------------------------------------------------------------------

    def lookup_arc(self, prmname: str) -> Optional[GeoArc]:
        """Look up a GeoArc by its arc_id / DSS variable name (case-insensitive)."""
        return self.arcs.get(prmname.upper())

    def lookup_node_by_variable(self, prmname: str) -> Optional[GeoNode]:
        """Look up the GeoNode corresponding to a DSS variable via reverse index."""
        cs3_id = self.variable_to_node.get(prmname.upper())
        return self.nodes.get(cs3_id) if cs3_id else None

    def lookup_node(self, cs3_id: str) -> Optional[GeoNode]:
        """Look up a GeoNode by its CalSim 3 ID (case-insensitive)."""
        return self.nodes.get(cs3_id.upper())

    def get_feature(self, feature_id: str):
        """Return (kind, record) for a feature_id.  kind is 'arc', 'node', or None."""
        arc = self.lookup_arc(feature_id)
        if arc:
            return "arc", arc
        node = self.lookup_node(feature_id)
        if node:
            return "node", node
        # Also try as a DSS variable → node mapping
        node = self.lookup_node_by_variable(feature_id)
        if node:
            return "node", node
        return None, None

    def hydro_regions(self) -> List[str]:
        """Sorted list of distinct hydro-region strings in this network."""
        regions: set = set()
        for a in self.arcs.values():
            if a.hydro_region:
                regions.add(a.hydro_region)
        for n in self.nodes.values():
            if n.hydro_region:
                regions.add(n.hydro_region)
        return sorted(regions)

    def feature_types(self) -> Dict[str, List[str]]:
        """Distinct node_type and arc_type strings, returned as separate sorted lists."""
        node_types: set = set()
        arc_types: set = set()
        for a in self.arcs.values():
            if a.arc_type:
                arc_types.add(a.arc_type)
        for n in self.nodes.values():
            if n.node_type:
                node_types.add(n.node_type)
        return {"node_types": sorted(node_types), "arc_types": sorted(arc_types)}
