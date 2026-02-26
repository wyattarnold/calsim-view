"""
Topology diagnostics: cross-reference GeoNetwork (GeoSchematic geometry) against
WRESL connectivity constraints (the solver's authoritative flow-balance equations).

Usage (within loader / __main__):

    from csview.geo.wresl_parser import parse_connectivity
    from csview.geo.diagnostics import run_diagnostics

    connectivity = parse_connectivity(wresl_dir)
    report = run_diagnostics(gn, connectivity)
    print(report.summary())
"""

from __future__ import annotations

import logging
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)

# Arc-variable prefixes that SHOULD have geometry in the schematic.
# We only flag "arc_no_geo" for these — delivery / return-flow arcs (D_, RP_,
# RU_, etc.) legitimately have no schematic LineString.
_GEO_EXPECTED_PREFIXES = ("C_", "I_", "E_", "S_",)


@dataclass
class TopoIssue:
    """One detected topology inconsistency."""
    kind: str              # issue category (see constants below)
    feature_id: str        # arc_id or node_id that has the problem
    message: str
    geo_value: Optional[str] = None     # what the GeoJSON says
    wresl_value: Optional[str] = None   # what the WRESL equations say


# Issue kind constants
ARC_NO_CONNECTIVITY      = "arc_no_connectivity"      # arc in GeoJSON, absent from WRESL
ARC_NO_GEO               = "arc_no_geo"               # arc in WRESL, absent from GeoJSON
FROM_NODE_MISMATCH       = "from_node_mismatch"       # GeoJSON from_node != WRESL-derived from
TO_NODE_MISMATCH         = "to_node_mismatch"         # GeoJSON to_node   != WRESL-derived to
NODE_NO_CONTINUITY       = "node_no_continuity"       # GeoJSON node has no continuity equation
NODE_NAME_MISMATCH       = "node_name_mismatch"       # GeoJSON node ID is close to a WRESL node (likely typo)
ARC_ENDPOINT_SUGGESTION  = "arc_endpoint_suggestion"  # geo arc & WRESL arc share from-node but differ in to-node


# ---------------------------------------------------------------------------
# Fuzzy-matching helpers (Levenshtein + alpha-prefix anchor)
# ---------------------------------------------------------------------------

_SPLIT_RE = re.compile(r'^([A-Za-z_]+)(\d*)$')

def _split_id(s: str) -> Tuple[str, str]:
    m = _SPLIT_RE.match(s)
    return (m.group(1).upper(), m.group(2)) if m else (s.upper(), "")


def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    n, m = len(a), len(b)
    if n == 0: return m
    if m == 0: return n
    prev = list(range(m + 1))
    for i in range(1, n + 1):
        curr = [i] + [0] * m
        for j in range(1, m + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            curr[j] = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
        prev = curr
    return prev[m]


def _edit_description(a: str, b: str) -> str:
    """Human-readable description of the edit between two strings."""
    la, lb = len(a), len(b)
    if la == lb:
        diffs = [(i, a[i], b[i]) for i in range(la) if a[i] != b[i]]
        if len(diffs) == 2:
            i, j = diffs[0][0], diffs[1][0]
            if j == i + 1 and a[i] == b[j] and a[j] == b[i]:
                return f"transposition [{i},{j}]: {a[i]}{a[j]} <-> {b[i]}{b[j]}"
        parts = ", ".join(f"pos {p}: {x}->{y}" for p, x, y in diffs)
        return f"substitution ({parts})"
    if la < lb:
        return f"insertion: '{a}' -> '{b}'"
    return f"deletion: '{a}' -> '{b}'"


def _find_fuzzy_matches(
    geo_ids: List[str],
    wresl_ids: List[str],
    max_dist: int = 2,
) -> List[Tuple[str, str, int, str]]:
    """Return (geo_id, wresl_id, edit_dist, edit_desc) for close matches.

    Only considers pairs where the alpha prefix has edit distance <= 1,
    which prevents cross-basin false positives on short numeric codes.
    """
    wresl_split = {w: _split_id(w) for w in wresl_ids}
    results = []
    for geo_id in geo_ids:
        gp, _ = _split_id(geo_id)
        best: Optional[Tuple[int, str]] = None
        for w_id, (wp, _) in wresl_split.items():
            if _levenshtein(gp, wp) > 1:
                continue
            dist = _levenshtein(geo_id, w_id)
            if dist > max_dist:
                continue
            if best is None or dist < best[0]:
                best = (dist, w_id)
        if best:
            dist, w_id = best
            results.append((geo_id, w_id, dist, _edit_description(geo_id, w_id)))
    return results


@dataclass
class DiagnosticsReport:
    issues: List[TopoIssue] = field(default_factory=list)
    stats: Dict[str, Any] = field(default_factory=dict)

    # WRESL-derived topology maps, populated by run_diagnostics().
    # Callers can use these to patch GeoArc from_node / to_node.
    wresl_from: Dict[str, str] = field(default_factory=dict)  # arc_id -> from_node
    wresl_to:   Dict[str, str] = field(default_factory=dict)  # arc_id -> to_node
    all_wresl_arcs: Set[str] = field(default_factory=set)     # every arc in any connectivity eq

    # Populated by the arc_endpoint_suggestion check.
    # Maps geo arc_id -> best-matching WRESL arc_id for arcs that appear to be
    # the same physical connection with different downstream node labels.
    arc_suggestions: Dict[str, str] = field(default_factory=dict)

    def add(self, issue: TopoIssue) -> None:
        self.issues.append(issue)

    def by_kind(self, kind: str) -> List[TopoIssue]:
        return [i for i in self.issues if i.kind == kind]

    def summary(self) -> str:
        by_kind: Dict[str, int] = {}
        for iss in self.issues:
            by_kind[iss.kind] = by_kind.get(iss.kind, 0) + 1
        lines = [
            "-" * 60,
            f"Topology diagnostics  ({len(self.issues)} issues total)",
        ]
        for k in (ARC_NO_CONNECTIVITY, ARC_NO_GEO,
                  ARC_ENDPOINT_SUGGESTION,
                  FROM_NODE_MISMATCH, TO_NODE_MISMATCH,
                  NODE_NO_CONTINUITY, NODE_NAME_MISMATCH):
            n = by_kind.get(k, 0)
            if n:
                lines.append(f"  {k:30s}: {n:4d}")
        lines.append("-" * 60)
        return "\n".join(lines)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "stats":  self.stats,
            "issues": [asdict(i) for i in self.issues],
        }


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def _build_wresl_topology(
    connectivity: Dict,
) -> Tuple[Dict[str, str], Dict[str, str], Set[str]]:
    """Derive from_node / to_node maps from WRESL connectivity equations.

    Returns ``(wresl_from, wresl_to, all_wresl_arcs)``.
    """
    wresl_from: Dict[str, str] = {}
    wresl_to:   Dict[str, str] = {}
    all_wresl_arcs: Set[str] = set()
    for node_id, nc in connectivity.items():
        for arc in nc.outflow_arcs:
            all_wresl_arcs.add(arc)
            wresl_from[arc] = node_id
        for arc in nc.inflow_arcs:
            all_wresl_arcs.add(arc)
            wresl_to[arc] = node_id
    return wresl_from, wresl_to, all_wresl_arcs


_DELIVERY_PREFIXES = ("D_", "R_", "RP_", "RU_")


def _check_arc_no_connectivity(
    report: DiagnosticsReport,
    gn: Any,
    geo_arc_ids: Set[str],
    all_wresl_arcs: Set[str],
) -> None:
    """Check 1: GeoJSON arcs with no WRESL flow-balance equation."""
    for arc_id in sorted(geo_arc_ids):
        arc = gn.arcs[arc_id]
        arc_type = arc.arc_type or ""
        if arc_type not in ("Channel", "Inflow", "Evaporation", "Spill"):
            continue
        if arc_id not in all_wresl_arcs:
            report.add(TopoIssue(
                kind=ARC_NO_CONNECTIVITY,
                feature_id=arc_id,
                message=(
                    f"Arc {arc_id} ({arc_type}) has GeoJSON geometry but is never "
                    f"referenced in any constraints-Connectivity equation."
                ),
            ))


def _check_delivery_no_define(
    report: DiagnosticsReport,
    gn: Any,
    geo_arc_ids: Set[str],
    wresl_catalog: Any,
) -> None:
    """Check 1b: delivery arcs whose WRESL define is commented out."""
    if wresl_catalog is None:
        return
    defined_vars: Set[str] = {k.upper() for k in wresl_catalog.variables.keys()}
    for arc_id in sorted(geo_arc_ids):
        arc = gn.arcs[arc_id]
        if not arc_id.upper().startswith(_DELIVERY_PREFIXES):
            continue
        if arc_id.upper() not in defined_vars:
            report.add(TopoIssue(
                kind=ARC_NO_CONNECTIVITY,
                feature_id=arc_id,
                message=(
                    f"Arc {arc_id} ({arc.arc_type}) is in the GeoSchematic but "
                    f"its WRESL define statement is absent or commented out."
                ),
            ))


def _check_arc_no_geo(
    report: DiagnosticsReport,
    all_wresl_arcs: Set[str],
    geo_arc_ids: Set[str],
) -> None:
    """Check 2: WRESL arcs expected to have geometry but absent from GeoJSON."""
    for arc_id in sorted(all_wresl_arcs - geo_arc_ids):
        if arc_id.startswith(_GEO_EXPECTED_PREFIXES):
            report.add(TopoIssue(
                kind=ARC_NO_GEO,
                feature_id=arc_id,
                message=(
                    f"Arc {arc_id} appears in WRESL connectivity equations "
                    f"but has no geometry in the GeoSchematic."
                ),
            ))


def _check_endpoint_mismatches(
    report: DiagnosticsReport,
    gn: Any,
    geo_arc_ids: Set[str],
    all_wresl_arcs: Set[str],
    wresl_from: Dict[str, str],
    wresl_to: Dict[str, str],
) -> None:
    """Checks 3 & 4: from_node / to_node mismatches between GeoJSON and WRESL."""
    for arc_id in sorted(geo_arc_ids & all_wresl_arcs):
        arc = gn.arcs[arc_id]
        geo_from = (arc.from_node or "").upper() or None
        geo_to   = (arc.to_node   or "").upper() or None
        w_from   = wresl_from.get(arc_id)
        w_to     = wresl_to.get(arc_id)

        if w_from and geo_from and w_from != geo_from:
            report.add(TopoIssue(
                kind=FROM_NODE_MISMATCH,
                feature_id=arc_id,
                message=(
                    f"Arc {arc_id}: GeoJSON from_node={geo_from!r} but "
                    f"WRESL equations place it as an outflow from {w_from!r}."
                ),
                geo_value=geo_from,
                wresl_value=w_from,
            ))

        if w_to and geo_to and w_to != geo_to:
            report.add(TopoIssue(
                kind=TO_NODE_MISMATCH,
                feature_id=arc_id,
                message=(
                    f"Arc {arc_id}: GeoJSON to_node={geo_to!r} but "
                    f"WRESL equations place it as an inflow to {w_to!r}."
                ),
                geo_value=geo_to,
                wresl_value=w_to,
            ))


def _check_node_no_continuity(
    report: DiagnosticsReport,
    gn: Any,
    geo_node_ids: Set[str],
    wresl_node_ids: Set[str],
) -> List[str]:
    """Check 5: GeoJSON nodes without a continuity equation.

    Returns the list of flagged node IDs (used by the fuzzy-match check).
    """
    no_cont_ids: List[str] = []
    for node_id in sorted(geo_node_ids - wresl_node_ids):
        n = gn.nodes[node_id]
        node_type = n.node_type or "Unknown"
        if node_type not in ("Junction", "Reservoir", "Inflow", "Groundwater",
                             "Evaporation"):
            continue
        no_cont_ids.append(node_id)
        report.add(TopoIssue(
            kind=NODE_NO_CONTINUITY,
            feature_id=node_id,
            message=(
                f"Node {node_id} ({node_type}) has GeoJSON geometry but no "
                f"corresponding continuity equation in the WRESL system files."
            ),
        ))
    return no_cont_ids


def _check_node_name_typos(
    report: DiagnosticsReport,
    gn: Any,
    no_cont_ids: List[str],
    wresl_node_ids: Set[str],
) -> None:
    """Check 6: no-continuity nodes whose name is close to a real WRESL node."""
    fuzzy_matches = _find_fuzzy_matches(
        no_cont_ids, sorted(wresl_node_ids), max_dist=2
    )
    for geo_id, wresl_id, dist, edit_desc in sorted(fuzzy_matches):
        n = gn.nodes[geo_id]
        node_type = n.node_type or "Unknown"
        report.add(TopoIssue(
            kind=NODE_NAME_MISMATCH,
            feature_id=geo_id,
            message=(
                f"Node {geo_id} ({node_type}) has no continuity equation but "
                f"closely matches WRESL node {wresl_id!r} "
                f"(edit distance {dist}: {edit_desc}). Possible ID typo."
            ),
            geo_value=geo_id,
            wresl_value=wresl_id,
        ))
    logger.info(
        "Fuzzy node name check: %d likely typos (dist=1), %d possible (dist=2)",
        sum(1 for *_, d, __ in fuzzy_matches if d == 1),
        sum(1 for *_, d, __ in fuzzy_matches if d == 2),
    )


def _arc_type_and_from(arc_id: str) -> Tuple[Optional[str], Optional[str]]:
    """Parse ``TYPE_FROM_TO`` arc naming convention."""
    parts = arc_id.split('_')
    if len(parts) >= 3:
        return parts[0].upper(), parts[1].upper()
    return None, None


def _check_arc_endpoint_suggestions(
    report: DiagnosticsReport,
    geo_arc_ids: Set[str],
    geo_node_ids: Set[str],
    all_wresl_arcs: Set[str],
) -> None:
    """Check 7: suggest WRESL arcs that likely match unconnected geo arcs.

    Cross-references ``arc_no_connectivity`` (geo-only) arcs with WRESL arcs
    that have no geometry, sharing the same type prefix and from-node.
    """
    no_conn_ids = {i.feature_id for i in report.by_kind(ARC_NO_CONNECTIVITY)}
    wresl_no_geo_ids = all_wresl_arcs - geo_arc_ids

    # Index WRESL-only arcs by (type, from_node), restricted to known GeoNodes
    wresl_by_key: Dict[Tuple[str, str], List[str]] = {}
    for arc_id in sorted(wresl_no_geo_ids):
        t, fn = _arc_type_and_from(arc_id)
        if t and fn and fn in geo_node_ids:
            wresl_by_key.setdefault((t, fn), []).append(arc_id)

    for arc_id in sorted(no_conn_ids):
        t, fn = _arc_type_and_from(arc_id)
        if not (t and fn and fn in geo_node_ids):
            continue
        candidates = wresl_by_key.get((t, fn), [])
        for wresl_arc in candidates:
            report.add(TopoIssue(
                kind=ARC_ENDPOINT_SUGGESTION,
                feature_id=arc_id,
                message=(
                    f"Geo arc {arc_id} (no WRESL match) may correspond to "
                    f"WRESL arc {wresl_arc} (no GeoJSON geometry): same "
                    f"type '{t}' and from-node '{fn}', differing only in "
                    f"downstream node label."
                ),
                wresl_value=wresl_arc,
            ))
        if candidates and arc_id not in report.arc_suggestions:
            report.arc_suggestions[arc_id] = candidates[0]

    n_suggestions = len(report.arc_suggestions)
    if n_suggestions:
        print(f"  arc_endpoint_suggestion: {n_suggestions} geo arcs with probable WRESL match.")


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run_diagnostics(gn: Any, connectivity: Dict, wresl_catalog: Any = None) -> DiagnosticsReport:
    """Cross-reference *gn* (GeoNetwork) with *connectivity* map.

    ``connectivity`` is the dict returned by
    ``wresl_parser.parse_connectivity()``.

    ``wresl_catalog`` is the optional :class:`~csview.geo.wresl_parser.WreslCatalog`
    returned by ``parse_system_tables()``.  When provided, delivery arcs (D_, R_,
    RP_, RU_ prefix) whose ``define`` statement is commented out (absent from the
    active catalog) are also flagged as :data:`ARC_NO_CONNECTIVITY`.

    Returns a :class:`DiagnosticsReport` with all detected issues.
    """
    report = DiagnosticsReport()

    geo_arc_ids:  Set[str] = set(gn.arcs.keys())
    geo_node_ids: Set[str] = set(gn.nodes.keys())
    wresl_node_ids: Set[str] = set(connectivity.keys())

    wresl_from, wresl_to, all_wresl_arcs = _build_wresl_topology(connectivity)
    report.wresl_from = wresl_from
    report.wresl_to   = wresl_to
    report.all_wresl_arcs = all_wresl_arcs

    _check_arc_no_connectivity(report, gn, geo_arc_ids, all_wresl_arcs)
    _check_delivery_no_define(report, gn, geo_arc_ids, wresl_catalog)
    _check_arc_no_geo(report, all_wresl_arcs, geo_arc_ids)
    _check_endpoint_mismatches(report, gn, geo_arc_ids, all_wresl_arcs,
                               wresl_from, wresl_to)
    no_cont_ids = _check_node_no_continuity(report, gn, geo_node_ids, wresl_node_ids)
    _check_node_name_typos(report, gn, no_cont_ids, wresl_node_ids)
    _check_arc_endpoint_suggestions(report, geo_arc_ids, geo_node_ids, all_wresl_arcs)

    report.stats = {
        "geo_arcs":       len(geo_arc_ids),
        "wresl_arcs":     len(all_wresl_arcs),
        "shared_arcs":    len(geo_arc_ids & all_wresl_arcs),
        "geo_nodes":      len(geo_node_ids),
        "wresl_nodes":    len(wresl_node_ids),
        "total_issues":   len(report.issues),
        "arc_no_connectivity":     len(report.by_kind(ARC_NO_CONNECTIVITY)),
        "arc_no_geo":              len(report.by_kind(ARC_NO_GEO)),
        "arc_endpoint_suggestion": len(report.by_kind(ARC_ENDPOINT_SUGGESTION)),
        "from_node_mismatch":      len(report.by_kind(FROM_NODE_MISMATCH)),
        "to_node_mismatch":        len(report.by_kind(TO_NODE_MISMATCH)),
        "node_no_continuity":      len(report.by_kind(NODE_NO_CONTINUITY)),
        "node_name_mismatch":      len(report.by_kind(NODE_NAME_MISMATCH)),
    }
    return report
