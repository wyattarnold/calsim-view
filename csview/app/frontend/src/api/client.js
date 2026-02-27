/**
 * API client — thin wrappers around fetch for all CalSim View API endpoints.
 */

const BASE = "/api";

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** Full GeoJSON FeatureCollection (arcs + nodes). */
export const fetchNetwork = () => get("/network");

/** Summary list of all features (nodes + arcs). */
export const fetchFeatures = (params = {}) => {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, v]) => v != null))
  ).toString();
  return get(`/network/features${qs ? "?" + qs : ""}`);
};

/** Full detail for a single feature (node or arc). */
export const fetchFeature = (featureId) =>
  get(`/network/features/${encodeURIComponent(featureId)}`);

/** Neighborhood subgraph (nodes + arcs within `depth` hops). */
export const fetchNeighborhood = (featureId, depth = 2) =>
  get(`/network/features/${encodeURIComponent(featureId)}/neighborhood?depth=${depth}`);

/** Distinct hydro regions. */
export const fetchRegions = () => get("/network/regions");

/** Distinct node types. */
export const fetchNodeTypes = () => get("/network/types");

/** Distinct arc types. */
export const fetchArcTypes = () => get("/network/arc-types");

/** Overlay GeoJSON layer (watersheds, water_budget, demand_unit, c2vsim_elements, c2vsim_subregions). */
export const fetchOverlay = (layer) =>
  get(`/network/overlays/${encodeURIComponent(layer)}`);

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** List of available studies. */
export const fetchStudies = () => get("/study/studies");

/**
 * All result timeseries for a GeoSchematic feature.
 * @param {string} featureId  - GeoSchematic feature_id (arc_id or cs3_id)
 * @param {string|null} study - study name (defaults to active)
 */
export const fetchFeatureResults = (featureId, study = null) => {
  const params = study ? `?study=${encodeURIComponent(study)}` : "";
  return get(`/study/feature/${encodeURIComponent(featureId)}${params}`);
};

// ---------------------------------------------------------------------------
// GW Budget
// ---------------------------------------------------------------------------

/** GW budget metadata (available WBAs, C-parts, units). */
export const fetchGwBudgetMeta = (study = null) => {
  const params = study ? `?study=${encodeURIComponent(study)}` : "";
  return get(`/study/gw_budget/meta${params}`);
};

/** GW budget time series for a Water Budget Area. */
export const fetchGwBudget = (wbaId, study = null) => {
  const params = study ? `?study=${encodeURIComponent(study)}` : "";
  return get(`/study/gw_budget/${encodeURIComponent(wbaId)}${params}`);
};
