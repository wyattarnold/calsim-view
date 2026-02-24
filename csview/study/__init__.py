"""
csview.study — pre-built study results for fast API serving.

Build results from DSS (one-time per study)::

    python -m csview.study \\
        --source  reference/calsim-studies/study_a \\
        --catalog data/network/catalog.json \\
        --out     data/study/study_a/

Loads at runtime from Parquet::

    from csview.study.store import StudyStore
    store = StudyStore.from_dir(Path("data/study/study_a"))
    series = store.get_series("C_FOLSM")
"""
from csview.study.store import StudyStore

__all__ = ["StudyStore"]
