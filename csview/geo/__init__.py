"""
csview.geo — GeoSchematic-driven CalSim 3 network model.

The network is built from the authoritative CalSim3 Geographic Schematic
GeoJSON files rather than from the XML diagram.

Quick start
-----------
Build network artifacts (one-time, or when GeoSchematic changes)::

    python -m csview.geo \\
        --geo-dir reference/geoschematic \\
        --wresl    reference/calsim-studies/study_a/Run/System \\
        --out      network/

Load the pre-built network at runtime::

    from csview.geo.loader import load_from_catalog
    gn = load_from_catalog(Path("network"))
"""
from csview.geo.models import GeoArc, GeoNetwork, GeoNode

__all__ = ["GeoNode", "GeoArc", "GeoNetwork"]
