# calsim-view

An interactive viewer for CalSim 3 network schematics and model results.

## Overview

calsim-view is a web application that lets you explore the CalSim 3 water
resources model network and inspect simulation results. It provides:

- **Interactive map** — the full CalSim 3 GeoSchematic rendered as a Leaflet
  map with nodes and arcs styled by type (reservoirs, channels, diversions, etc.)
- **Feature detail panel** — click any node or arc to see its metadata and
  time series charts of modeled results (storage, flow, shortage)
- **Neighborhood graph** — force-directed subgraph showing the local network
  topology around a selected feature
- **Time series charts** — monthly results plotted with a sliding date-range
  filter; flow/shortage values can be displayed in CFS or TAF
- **Study selector** — switch between multiple loaded CalSim studies

## Requirements

- Python dependencies: `fastapi`, `uvicorn`, `pandas`, `pyarrow`, `pydsstools` (see `pyproject.toml`)
- Node 18+ / npm 9+ (only needed to rebuild the frontend from source)

## Running the app

Pre-built artifacts (`data/network/` and `data/study/study_a/`) and a compiled
frontend (`csview/app/static/`) are included. Simply run:

```bat
python -m csview.app --network-dir data/network/ --study data/study/study_a
```

Then open **http://localhost:8000** in your browser.

**Common options**

| Flag | Default | Description |
|---|---|---|
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `8000` | Port |
| `--reload` | off | Auto-reload on source changes (dev) |
| `--verbose` | off | Debug logging |
| `--default-study` | first loaded | Study shown on startup |

To load multiple studies:

```bat
python -m csview.app ^
    --network-dir data/network/ ^
    --study data/study/study_a ^
    --study data/study/study_b
```

## Rebuilding artifacts (optional)

These steps are only needed if you have new raw data in `reference/` (gitignored).

### 1. Rebuild the network catalog

```bat
python -m csview.geo ^
    --geo-dir reference/geoschematic ^
    --wresl   reference/calsim-studies/study_a/Run/System ^
    --out     data/network/
```

### 2. Rebuild study results

```bat
python -m csview.study ^
    --source  reference/calsim-studies/study_a ^
    --catalog data/network/catalog.json ^
    --out     data/study/study_a/ ^
    --cache-dir data/study/study_a/.dss_cache
```

Always use `--cache-dir` to read from the DSS pickle cache (~10 s).
Without it the builder falls back to pydsstools and takes 3–5 min.

### 3. Rebuild the frontend

```bat
cd csview/app/frontend
npm install
npm run build
```
