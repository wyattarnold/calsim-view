"""
HEC-DSS reader for CalSim 3 output files.

Requires ``pydsstools``, which is available via conda only:
    conda install -c arthurlutz pydsstools

CalSim DSS pathname structure
------------------------------
    /A/B/C/D/E/F/
    A — model tag   (e.g. "CALSIM", "CALSIM-CALFEWS", "DWR-CSim")
    B — variable    (e.g. "S_SHSTA", "C_FOLSM", "SHRTG_08N_PR1")
    C — data type   (e.g. "STORAGE", "FLOW-CHANNEL", "SHORTAGE")
    D — start date  (often blank for regular/full-period records)
    E — interval    (e.g. "1MON")
    F — run/version (e.g. "DV", "SV", "2020D09EDR")

Typical usage
-------------
    from pathlib import Path
    from csview.study.dss_reader import DssFile

    with DssFile(Path("reference/calsim-studies/study_a/DSS/output/DCR2023_DV_...dss")) as dv:
        catalog = dv.catalog()
        storage = dv.read_timeseries("S_SHSTA")   # → pd.Series (monthly)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterator, List, Optional

import pandas as pd

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# pydsstools import — graceful failure so the rest of the package still loads
# ---------------------------------------------------------------------------
try:
    from pydsstools.heclib.dss import HecDss as _HecDss  # type: ignore
    PYDSSTOOLS_AVAILABLE = True
except ImportError:  # pragma: no cover
    _HecDss = None  # type: ignore
    PYDSSTOOLS_AVAILABLE = False
    logger.warning(
        "pydsstools not found. DSS reading is disabled. "
        "Install with: conda install -c arthurlutz pydsstools"
    )


# ---------------------------------------------------------------------------
# Pathname helpers
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class DssPathname:
    """Parsed HEC-DSS pathname."""
    raw: str
    a: str  # model tag
    b: str  # variable name
    c: str  # data type
    d: str  # start date (often blank)
    e: str  # interval
    f: str  # run/version

    @classmethod
    def parse(cls, raw: str) -> "DssPathname":
        """Parse a ``/A/B/C/D/E/F/`` string."""
        parts = raw.strip("/").split("/")
        # Pad to 6 parts to handle malformed paths
        while len(parts) < 6:
            parts.append("")
        a, b, c, d, e, f = parts[:6]
        return cls(raw=raw, a=a, b=b, c=c, d=d, e=e, f=f)

    @property
    def variable(self) -> str:
        """Return the B part (variable name) stripped of whitespace."""
        return self.b.strip()


def _catalog_from_fid(fid: "_HecDss") -> Dict[str, List[DssPathname]]:
    """Build {variable_name → [DssPathname, ...]} index from an open HecDss handle."""
    index: Dict[str, List[DssPathname]] = {}
    pathname_list: List[str] = fid.getPathnameList("/*/*/*/*/*/*/", sort=1)
    for raw in pathname_list:
        p = DssPathname.parse(raw)
        if p.variable:
            index.setdefault(p.variable, []).append(p)
    return index


# ---------------------------------------------------------------------------
# DssFile context manager
# ---------------------------------------------------------------------------

class DssFile:
    """Thin wrapper around pydsstools for one DSS file.

    Designed to be used as a context manager::

        with DssFile(path) as dss:
            ts = dss.read_timeseries("S_SHSTA")

    It can also be used without ``with`` — call :meth:`close` when done.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._fid: Optional["_HecDss"] = None
        self._index: Optional[Dict[str, List[DssPathname]]] = None

    # ------------------------------------------------------------------
    # Context manager
    # ------------------------------------------------------------------

    def __enter__(self) -> "DssFile":
        self.open()
        return self

    def __exit__(self, *_) -> None:
        self.close()

    def open(self) -> None:
        if not PYDSSTOOLS_AVAILABLE:
            raise RuntimeError(
                "pydsstools is not installed. "
                "Run: conda install -c arthurlutz pydsstools"
            )
        if self._fid is not None:
            return
        logger.info("Opening DSS file: %s", self.path)
        self._fid = _HecDss.Open(str(self.path))

    def close(self) -> None:
        if self._fid is not None:
            try:
                self._fid.close()
            except Exception as exc:
                logger.debug("Error closing DSS file: %s", exc)
            self._fid = None

    # ------------------------------------------------------------------
    # Catalog
    # ------------------------------------------------------------------

    def catalog(self) -> Dict[str, List[DssPathname]]:
        """Return ``{variable → [pathnames]}`` index (built lazily, then cached)."""
        if self._index is None:
            self._index = _catalog_from_fid(self._fid)
            logger.info("  %d unique variables in %s", len(self._index), self.path.name)
        return self._index

    def variables(self) -> List[str]:
        """Sorted list of all unique variable names in this DSS file."""
        return sorted(self.catalog().keys())

    def has_variable(self, name: str) -> bool:
        return name in self.catalog()

    # ------------------------------------------------------------------
    # Read time series
    # ------------------------------------------------------------------

    def read_timeseries(
        self,
        variable: str,
        prefer_interval: str = "1MON",
    ) -> pd.Series:
        """Read a monthly time series for *variable*, return a :class:`pandas.Series`.

        Parameters
        ----------
        variable:
            CalSim variable name (B part of the DSS pathname), e.g. ``"S_SHSTA"``.
        prefer_interval:
            Preferred E-part interval.  Falls back to the first available
            pathname for the variable if the preferred is not found.

        Returns
        -------
        pd.Series
            DatetimeIndex (monthly period-end), float64 values.
            Index name = variable, series name = variable.
        """
        index = self.catalog()
        if variable not in index:
            raise KeyError(f"Variable '{variable}' not found in {self.path.name}")

        paths = index[variable]
        # Filter to preferred interval; fall back to all paths
        interval_paths = [p for p in paths if p.e.upper() == prefer_interval.upper()]
        read_paths = interval_paths if interval_paths else paths

        # CalSim DSS files store time series in 10- or 30-year blocks; read
        # all blocks and concatenate into a single series.
        segments: list = []
        captured_units: str = ""
        captured_type: str = ""
        for p in read_paths:
            logger.debug("Reading %s from %s", p.raw, self.path.name)
            ts = self._fid.read_ts(p.raw)
            times = ts.pytimes
            values = list(ts.values)
            if not times:
                continue
            # Grab units/type from the first block that has them.
            if not captured_units and ts.units:
                captured_units = str(ts.units).strip()
            if not captured_type and ts.type:
                captured_type = str(ts.type).strip()
            seg = pd.Series(
                data=values,
                index=pd.DatetimeIndex(times),
                name=variable,
                dtype=float,
            )
            segments.append(seg)

        if not segments:
            raise KeyError(f"Variable '{variable}' yielded no data in {self.path.name}")

        series = pd.concat(segments).sort_index()
        series = series[~series.index.duplicated(keep="first")]
        # Snap to end-of-month (pydsstools returns start-of-month timestamps
        # for CalSim 1MON period data; callers expect end-of-month convention).
        series.index = series.index + pd.offsets.MonthEnd(0)
        # pydsstools uses -901.0 as missing-data sentinel; convert to NaN.
        series.replace(-901.0, float("nan"), inplace=True)
        series.dropna(inplace=True)
        series.name = variable
        series.index.name = "date"
        # Store DSS-native units and data type so callers don't have to guess.
        series.attrs["units"] = captured_units
        series.attrs["data_type"] = captured_type
        return series

    # ------------------------------------------------------------------
    # Batch read
    # ------------------------------------------------------------------

    def read_all(
        self,
        variables: Optional[List[str]] = None,
        prefer_interval: str = "1MON",
    ) -> pd.DataFrame:
        """Read multiple variables into a single DataFrame (columns = variables).

        If *variables* is None, reads every variable in the file.
        Variables that cannot be read are silently skipped.
        """
        if variables is None:
            variables = self.variables()

        frames: Dict[str, pd.Series] = {}
        for var in variables:
            try:
                frames[var] = self.read_timeseries(var, prefer_interval)
            except Exception as exc:
                logger.debug("Skipping %s: %s", var, exc)

        if not frames:
            return pd.DataFrame()
        return pd.concat(frames, axis=1)

    # ------------------------------------------------------------------
    # Iteration helpers
    # ------------------------------------------------------------------

    def iter_by_prefix(
        self,
        prefix: str,
        prefer_interval: str = "1MON",
    ) -> Iterator[pd.Series]:
        """Yield time series for all variables whose name starts with *prefix*."""
        for var in self.variables():
            if var.startswith(prefix):
                yield self.read_timeseries(var, prefer_interval)


# ---------------------------------------------------------------------------
# Convenience: open input + output DSS for a study
# ---------------------------------------------------------------------------

@dataclass
class StudyDss:
    """Pair of input (SV) and output (DV) DSS files for one CalSim study."""

    name: str
    path: Path          # study root (e.g. reference/calsim-studies/study_a)
    input_dss: Optional[DssFile] = None
    output_dss: Optional[DssFile] = None

    @classmethod
    def from_study_dir(cls, study_dir: Path) -> "StudyDss":
        """Auto-detect input and output DSS files inside ``DSS/input/`` and ``DSS/output/``."""
        study_dir = Path(study_dir)
        name = study_dir.name

        def _find_dss(subdir: Path) -> Optional[Path]:
            candidates = sorted(subdir.glob("*.dss"))
            if not candidates:
                return None
            if len(candidates) == 1:
                return candidates[0]
            # Prefer files containing "DV" (output) or "SV" (input) in their name
            for c in candidates:
                if "_DV_" in c.name.upper():
                    return c
            return candidates[0]

        sv_path = _find_dss(study_dir / "DSS" / "input")
        dv_path = _find_dss(study_dir / "DSS" / "output")

        return cls(
            name=name,
            path=study_dir,
            input_dss=DssFile(sv_path) if sv_path else None,
            output_dss=DssFile(dv_path) if dv_path else None,
        )
