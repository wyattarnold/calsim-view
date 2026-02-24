"""
Parse WRESL system-table files from the CalSim 3 Run/System/ directory tree.

WRESL syntax for variable declarations (one per line):
    define VARNAME  { std kind 'KIND' units 'UNITS' }
    define VARNAME  { timeseries kind 'KIND' units 'UNITS' }
    define VARNAME  { lower unbounded kind 'KIND' units 'UNITS' }
    define VARNAME  { value 123 }

We extract each declared variable name, its kind string, units, and the source
file, then map kind -> CalSim node/arc category.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Regex
# ---------------------------------------------------------------------------

_DEFINE_RE = re.compile(
    r"define\s+(\w+)\s*\{([^}]*)\}",
    re.IGNORECASE | re.DOTALL,
)
_KIND_RE = re.compile(r"kind\s+'([^']+)'", re.IGNORECASE)
_UNITS_RE = re.compile(r"units\s+'([^']+)'", re.IGNORECASE)

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


@dataclass
class WreslCatalog:
    """All variable definitions parsed from a Run/System/ directory tree."""
    variables: Dict[str, WreslVariable] = field(default_factory=dict)

    def get(self, name: str) -> Optional[WreslVariable]:
        return self.variables.get(name)

    def by_type(self, node_type: str) -> List[WreslVariable]:
        return [v for v in self.variables.values() if v.node_type == node_type]


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
        kind_m = _KIND_RE.search(body)
        units_m = _UNITS_RE.search(body)
        kind = kind_m.group(1) if kind_m else None
        units = units_m.group(1) if units_m else None
        node_type = _kind_to_node_type(kind) if kind else _infer_node_type_from_name(name)
        variables.append(WreslVariable(name=name, kind=kind, units=units,
                                       node_type=node_type, source_file=rel_path))
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
