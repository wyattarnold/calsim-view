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

## Frontend build

After any change to files under `calsim/app/frontend/src/`:

```bash
cd calsim/app/frontend && npm run build
```

The compiled output lands in `calsim/app/static/`. The server must be
restarted (or `--reload` must be active) to serve the new bundle.

## Python environment

```
C:\Users\warnold\Miniconda3\envs\py38\python.exe
```

## Running the server

```bash
python -m calsim.app \
    --network-dir network/ \
    --study study/danube_hist
```
