# AI Agent Instructions — CalSim View

## `.github/memory/IMPLEMENTATION.md` — project reference (read first)

Before working on any non-trivial task, read `.github/memory/IMPLEMENTATION.md` in
full. It is the single source of truth for the project structure, data
pipeline, API, and frontend.

## `.github/memory/IMPLEMENTATION.md` maintenance (mandatory)

**Whenever you make any of the following changes, update
`.github/memory/IMPLEMENTATION.md` in the same session before finishing:**

- Add, rename, or remove a Python module or package
- Add or modify a FastAPI endpoint, router, or Pydantic schema field
- Change the data pipeline (build steps, CLI arguments, artifact formats)
- Change a disk artifact (catalog.json structure, GeoJSON properties,
  Parquet schema, results_meta.json format)
- Add or remove a frontend component, or change its primary responsibilities
- Change a key design decision (identifier conventions, caching model, etc.)
- Update a dependency that changes behaviour (major version bumps)

Update the "Last updated" date at the bottom of `.github/memory/IMPLEMENTATION.md`
with every edit to that file.

## General coding conventions

- All GeoSchematic feature identifiers are **uppercase** (`feature_id`):
  nodes use `cs3_id.upper()`, arcs use `arc_id.upper()`.
- `feature_kind` in GeoJSON properties must be exactly `"arc"` or `"node"` —
  never the type sub-label. `arc_type` and `node_type` are separate properties.
- The neighborhood BFS must filter arc endpoints through `rendered_node_ids`
  (nodes that have a real `GeoNode` entry) to exclude phantom zone nodes
  `"02"`/`"03"`.
- Do not regenerate `network/catalog.json` or `network/network.geojson` at
  runtime; they are built once and loaded at startup.
- The Parquet file is loaded lazily on first results request; keep `StudyStore`
  construction lightweight.

## WRESL / CalSim 3 domain knowledge

- **Connectivity file naming is inconsistent.** Not all files are named exactly
  `constraints-Connectivity.wresl` — some have prefixes
  (`UpperStanislaus_constraints-connectivity.wresl`), suffixes
  (`constraints-Connectivity_Common.wresl`), or entirely different names
  (`Connectivity-table.wresl`). Any glob must use `*.wresl` filtered by
  `"connectivity" in name.lower()`.
- **`arc_no_geo` only flags `C_/I_/E_/S_` prefixes.**  Delivery (`D_`),
  return-flow (`R_/RP_/RU_`) arcs in WRESL intentionally have no GeoSchematic
  geometry. To cross-reference WRESL arcs against the GeoSchematic, use
  `all_wresl_arcs - geo_arc_ids` (not the `arc_no_geo` subset).
- **WRESL files on Windows use cp1252.** Always read with
  `encoding="utf-8", errors="replace"` to handle stray characters.

## Build ordering and dependencies

When rebuilding both network AND study artifacts, **always rebuild network
first** — the study builder reads `catalog.json` (arc IDs, node IDs,
`wresl_suggestion` targets) to decide which DSS variables to extract.

The study builder includes `wresl_suggestion` target arc IDs in its matching
set so their DSS data is extracted even though they have no GeoSchematic
geometry. This enables the app's "suggested WRESL arc" fallback.

## Frontend build

After any change to files under `csview/app/frontend/src/`:

```bash
cd csview/app/frontend && npm run build
```

The compiled output lands in `csview/app/static/`. The server must be
restarted (or `--reload` must be active) to serve the new bundle.

## Python environment

```
C:\Users\warnold\Miniconda3\envs\py38\python.exe
```

## Running the server

```bat
python -m csview.app --network-dir data/network/ --study data/study/study_a
```

## Running the network builder

```bat
C:\Users\warnold\Miniconda3\envs\py38\python.exe -m csview.geo ^
    --geo-dir reference/geoschematic ^
    --wresl reference/calsim-studies/study_a/Run/System ^
    --out data/network ^
    --diagnose --fix-topology
```

Runs in ~10 s; safe to run foreground/blocking.

## Running the study builder

**Always use `--cache-dir`** to read from the DSS pickle cache instead of the
raw DSS files. The cache lives in `data/study/study_a/.dss_cache/` and makes
the build complete in seconds rather than minutes:

```bat
C:\Users\warnold\Miniconda3\envs\py38\python.exe -m csview.study ^
    --source reference/calsim-studies/study_a ^
    --catalog data/network/catalog.json ^
    --out data/study/study_a/ ^
    --cache-dir data/study/study_a/.dss_cache
```

With the cache this runs in ~10 s; safe to run foreground/blocking.

Without `--cache-dir` the builder falls back to pydsstools and takes 3–5 min.
Only omit `--cache-dir` when the DSS files have changed and the cache needs
regenerating (the cache will be rebuilt automatically on the next run with
`--cache-dir` if the DSS file's mtime is newer than the pickle).

After the build, verify with:

```bat
type build_log.txt
```
