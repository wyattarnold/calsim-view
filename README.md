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
python -m csview.app serve --network-dir data/network/ --study data/study/study_a
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
| `--hosted` | off | Load from bundled data.zip (for Render deploy) |

To load multiple studies:

```bat
python -m csview.app serve ^
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
    --source  reference/calsim-studies/study_b ^
    --catalog data/network/catalog.json ^
    --out     data/study/study_b/ ^
    --cache-dir data/study/study_b/.dss_cache ^
    --run-path reference/calsim-studies/study_a
```

Always use `--cache-dir` to read from the DSS pickle cache (~10 s).
Without it the builder falls back to pydsstools and takes 3–5 min.

### 3. Rebuild the frontend

```bat
cd csview/app/frontend
npm install
npm run build
```

## Deploying on Render

The app can be deployed to [Render](https://render.com) using the included
`render.yaml`. The network and study artifacts are too large for git, so they
are bundled into a `data.zip` file and hosted as a GitHub Release asset.

### Step 1 — Build the data bundle

From the repo root, run:

```bat
python -m csview.app bundle ^
    --network-dir data/network/ ^
    --study data/study/study_a ^
    --study data/study/study_b
```

This writes `csview/app/data.zip` (~62 MB compressed). The file is gitignored
and must be uploaded to GitHub separately.

### Step 2 — Create a GitHub Release with the bundle

1. Go to your GitHub repo → **Releases** → **Draft a new release**
2. Click **Choose a tag** → type `v1.0-data` → click **Create new tag**
3. Set the title to `Data bundle v1.0`
4. Drag-drop `csview/app/data.zip` into the assets area at the bottom
5. Click **Publish release**

After publishing, copy the asset download URL from the release page. It will
look like:
```
https://github.com/<owner>/calsim-view/releases/download/v1.0-data/data.zip
```

### Step 3 — Create the Render web service

1. Log in to [Render](https://render.com) → **New** → **Web Service**
2. Connect your GitHub account and select the `calsim-view` repository
3. Render will detect `render.yaml` and pre-fill the settings. Verify:

   | Setting | Value |
   |---|---|
   | **Runtime** | Python |
   | **Root Directory** | `csview/app` |
   | **Build Command** | `bash ./build.sh` |
   | **Start Command** | `python -m csview.app serve --hosted --host 0.0.0.0 --port $PORT` |

4. Under **Environment Variables**, add:
   - **Key**: `DATA_ZIP_URL`
   - **Value**: the asset URL from Step 2

5. Click **Create Web Service** — Render will run `build.sh`, which:
   - Installs the Python package (`pip install -e ../../.`)
   - Downloads `data.zip` from `DATA_ZIP_URL`
   - Builds the React frontend (`npm ci && npm run build`)

6. Once the deploy completes, open the service URL in your browser.

### Updating the data bundle

After rebuilding network or study artifacts, re-run Step 1, upload the new
`data.zip` to a new GitHub Release (e.g. tag `v1.1-data`), update `DATA_ZIP_URL`
in Render, and trigger a manual redeploy.

### Testing hosted mode locally

```bat
python -m csview.app serve --hosted
```
