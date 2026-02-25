"""
Parse WRESL system-table files from the CalSim 3 Run/System/ directory tree.

WRESL syntax for variable declarations (one per line):
    define VARNAME  { std kind 'KIND' units 'UNITS' }
    define VARNAME  { timeseries kind 'KIND' units 'UNITS' }
    define VARNAME  { lower unbounded kind 'KIND' units 'UNITS' }
    define VARNAME  { lower 0 upper 840 kind 'CHANNEL' units 'CFS' }
    define VARNAME  { value 123 }

Connectivity constraints (in constraints-Connectivity.wresl files):
    goal continuityNODE { INFLOW1 + INFLOW2 - OUTFLOW = storage_change }

We also parse these goal statements to extract which arc variables flow into
and out of each node — giving us the solver's authoritative topology.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Regex
# ---------------------------------------------------------------------------

_DEFINE_RE = re.compile(
    r"define\s+(\w+)\s*\{([^}]*)\}",
    re.IGNORECASE | re.DOTALL,
)
_KIND_RE  = re.compile(r"kind\s+'([^']+)'",   re.IGNORECASE)
_UNITS_RE = re.compile(r"units\s+'([^']+)'",  re.IGNORECASE)
_UPPER_RE = re.compile(r"\bupper\s+([\d.]+)", re.IGNORECASE)

# goal continuity<NODE> { ... = ... }
_GOAL_CONTINUITY_RE = re.compile(
    r"goal\s+continuity(\w+)\s*\{([^}]*)\}",
    re.IGNORECASE | re.DOTALL,
)

# ---------------------------------------------------------------------------
# Kind -> node_type mapping
# ---------------------------------------------------------------------------

KIND_TO_NODE_TYPE: Dict[str, str] = {
    "STORAGE":           "Reservoir",
    "STORAGE-ZONE":      "Reservoir",
    "EVAPORATION":       "Evaporation",
    "EVAPORATION-RATE":  "Evaporation",
    "SURFACE-AREA":      "Surface Area",
    "CHANNEL":           "Channel",
    "DIVERSION":         "Diversion",
    "FLOW":              "Inflow",
    "ADD-FLOW":          "Inflow",
    "INFLOW":            "Inflow",
    "GROUNDWATER":       "Groundwater",
    "GW-STORAGE":        "Groundwater",
    "GROUNDWATER-FLOW":  "Groundwater",
    "DELIVERY":          "Demand-Agricultural",
    "AG-DELIVERY":       "Demand-Agricultural",
    "URBAN-DELIVERY":    "Demand-Urban",
    "URBAN-DEMAND":      "Demand-Urban",
    "SHORTAGE":          "Shortage",
    "RETURN-FLOW":       "Return Flow",
    "WATER-QUALITY":     "Water Quality",
    "SEEPAGE":           "Seepage",
    "TILE-DRAIN":        "Tile Drain",
    "DEEP-PERCOLATION":  "Deep Percolation",
    "MIN-FLOW":          "Minimum Flow",
    "CONTRACT":          "Contract",
    "POWER":             "Power",
}


def _kind_to_node_type(kind: str) -> str:
    return KIND_TO_NODE_TYPE.get(kind.upper(), kind.title())


_PREFIX_TO_NODE_TYPE = [
    ("S_",     "Reservoir"),
    ("E_",     "Evaporation"),
    ("A_",     "Surface Area"),
    ("C_",     "Channel"),
    ("D_",     "Diversion"),
    ("I_",     "Inflow"),
    ("GP_",    "Groundwater"),
    ("GW_",    "Groundwater"),
    ("DG_",    "Demand-Agricultural"),
    ("DN_",    "Demand-Agricultural"),
    ("AW_",    "Demand-Agricultural"),
    ("AWR_",   "Demand-Agricultural"),
    ("AWO_",   "Demand-Agricultural"),
    ("AWW_",   "Demand-Agricultural"),
    ("UD_",    "Demand-Urban"),
    ("UB_",    "Demand-Urban"),
    ("SHRTG_", "Shortage"),
    ("RP_",    "Return Flow"),
    ("RU_",    "Return Flow"),
    ("WQ_",    "Water Quality"),
    ("MF_",    "Minimum Flow"),
]


def _infer_node_type_from_name(name: str) -> str:
    for prefix, ntype in _PREFIX_TO_NODE_TYPE:
        if name.upper().startswith(prefix):
            return ntype
    return "Other"


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class WreslVariable:
    """A single `define` statement parsed from a WRESL file."""
    name: str
    kind: Optional[str]
    units: Optional[str]
    node_type: str
    source_file: str
    capacity: Optional[float] = None   # upper bound from define statement, if present


@dataclass
class WreslCatalog:
    """All variable definitions parsed from a Run/System/ directory tree."""
    variables: Dict[str, WreslVariable] = field(default_factory=dict)

    def get(self, name: str) -> Optional[WreslVariable]:
        return self.variables.get(name)

    def by_type(self, node_type: str) -> List[WreslVariable]:
        return [v for v in self.variables.values() if v.node_type == node_type]


@dataclass
class NodeConnectivity:
    """Flow-balance equation for one node from a constraints-Connectivity file.

    Positive terms in the equation are *inflow arcs* to this node.
    Negative terms are *outflow arcs* from this node.
    Storage change terms (S_*) are stripped out.
    """
    node_id: str            # e.g. "BRR067" (uppercase)
    inflow_arcs: List[str]  # uppercase variable names on the + side
    outflow_arcs: List[str] # uppercase variable names on the - side
    source_file: str


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

def _strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.DOTALL)
    text = re.sub(r"!.*", "", text)
    return text


def parse_wresl_file(filepath: Path, base_dir: Optional[Path] = None) -> List[WreslVariable]:
    try:
        text = filepath.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        logger.warning("Could not read %s: %s", filepath, exc)
        return []

    text = _strip_comments(text)
    rel_path = str(filepath.relative_to(base_dir)) if base_dir else filepath.name

    variables: List[WreslVariable] = []
    for m in _DEFINE_RE.finditer(text):
        name = m.group(1)
        body = m.group(2)
        kind_m  = _KIND_RE.search(body)
        units_m = _UNITS_RE.search(body)
        upper_m = _UPPER_RE.search(body)
        kind  = kind_m.group(1)  if kind_m  else None
        units = units_m.group(1) if units_m else None
        node_type = _kind_to_node_type(kind) if kind else _infer_node_type_from_name(name)
        capacity: Optional[float] = None
        if upper_m:
            try:
                v = float(upper_m.group(1))
                # 99999 / 9999 are the CalSim "unbounded" sentinels — treat as None
                if v < 99990:
                    capacity = v
            except ValueError:
                pass
        variables.append(WreslVariable(name=name, kind=kind, units=units,
                                       node_type=node_type, source_file=rel_path,
                                       capacity=capacity))
    return variables


def parse_system_tables(system_dir: Path) -> WreslCatalog:
    """Recursively parse all .wresl files under *system_dir*."""
    system_dir = Path(system_dir)
    catalog = WreslCatalog()
    wresl_files = sorted(system_dir.rglob("*.wresl"))
    logger.info("Parsing %d WRESL files under %s", len(wresl_files), system_dir)
    for fpath in wresl_files:
        for v in parse_wresl_file(fpath, base_dir=system_dir):
            catalog.variables[v.name] = v
    logger.info("  Catalog: %d variable definitions", len(catalog.variables))
    return catalog


# ---------------------------------------------------------------------------
# Connectivity constraint parsing
# ---------------------------------------------------------------------------

def _parse_balance_lhs(body: str) -> Tuple[List[str], List[str]]:
    """Parse the *left-hand side* of a WRESL flow-balance goal body.

    Returns (inflow_arcs, outflow_arcs) — variable names that appear with a
    positive / negative sign respectively.  Storage terms (S_*) and numeric
    constants are excluded.

    Strategy:
      1. Discard everything after the first ``=`` (RHS holds storage change).
      2. Strip lag references ``VAR(-1)`` and coefficient multiplications
         ``* word``
      3. Find all ``[+|-]IDENTIFIER`` tokens and classify by sign.
    """
    lhs = body.split("=")[0]
    # Remove lag terms: VARNAME(-1)
    lhs = re.sub(r"\w+\s*\(\s*-\s*1\s*\)", "", lhs)
    # Remove coefficient multiplications: * taf_cfs, * 0.5, etc.
    lhs = re.sub(r"\*\s*[\w.]+", "", lhs)
    # Collapse whitespace
    lhs = re.sub(r"\s+", "", lhs)
    # Ensure expression starts with a sign so the pattern below matches everything
    if lhs and (lhs[0].isalpha() or lhs[0] == "_"):
        lhs = "+" + lhs

    inflows: List[str] = []
    outflows: List[str] = []
    for m in re.finditer(r"([+\-])([A-Za-z_]\w*)", lhs):
        sign = m.group(1)
        var  = m.group(2).upper()
        # Skip storage (S_), numeric-looking short tokens, or plain constants
        if var.startswith("S_"):
            continue
        if len(var) <= 2:          # e.g. "RS" residuals sometimes appear
            continue
        if sign == "+":
            inflows.append(var)
        else:
            outflows.append(var)
    return inflows, outflows


def parse_connectivity_file(
    filepath: Path,
    base_dir: Optional[Path] = None,
) -> List[NodeConnectivity]:
    """Extract all ``goal continuity<NODE>`` statements from one file."""
    try:
        text = filepath.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        logger.warning("Could not read %s: %s", filepath, exc)
        return []

    text     = _strip_comments(text)
    rel_path = str(filepath.relative_to(base_dir)) if base_dir else filepath.name
    result: List[NodeConnectivity] = []

    for m in _GOAL_CONTINUITY_RE.finditer(text):
        node_id = m.group(1).upper()
        body    = m.group(2)
        inflows, outflows = _parse_balance_lhs(body)
        if inflows or outflows:
            result.append(NodeConnectivity(
                node_id=node_id,
                inflow_arcs=inflows,
                outflow_arcs=outflows,
                source_file=rel_path,
            ))
    return result


def parse_connectivity(system_dir: Path) -> Dict[str, NodeConnectivity]:
    """Parse all connectivity-constraint WRESL files under *system_dir*.

    Matches any file whose name contains "connectivity" (case-insensitive),
    which covers the common naming patterns across sub-basins:
      - constraints-Connectivity.wresl
      - UpperStanislaus_constraints-connectivity.wresl  (prefixed, lowercase)
      - constraints-Connectivity_Common.wresl           (suffixed)
      - Connectivity-table.wresl                        (SOD naming)

    Returns a mapping: node_id (uppercase) → NodeConnectivity.
    If the same node appears in multiple files the last definition wins
    (they should be unique, but this is safe).
    """
    system_dir  = Path(system_dir)
    conn_files  = sorted(
        p for p in system_dir.rglob("*.wresl")
        if "connectivity" in p.name.lower()
    )
    logger.info("Parsing %d connectivity files under %s", len(conn_files), system_dir)
    catalog: Dict[str, NodeConnectivity] = {}
    for fpath in conn_files:
        for nc in parse_connectivity_file(fpath, base_dir=system_dir):
            catalog[nc.node_id] = nc
    logger.info("  Connectivity: %d node equations", len(catalog))
    return catalog
