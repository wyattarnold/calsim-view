/**
 * Shared visual style constants for CalSim 3 map features.
 *
 * Single source of truth used by NetworkMap (Leaflet) and
 * NeighborhoodGraph (SVG) so node/arc colors stay in sync.
 */

// ---------------------------------------------------------------------------
// Node styles  {color, r (radius), w (stroke weight), fo (fillOpacity)}
// ---------------------------------------------------------------------------

export const NODE_STYLE = {
  "Reservoir":              { color: "#3b82f6", r: 9,  w: 1.5, fo: 0.92 },
  "Demand-Agricultural":    { color: "#eab308", r: 6,  w: 1.2, fo: 0.85 },
  "Demand-Urban":           { color: "#f43f5e", r: 6,  w: 1.2, fo: 0.85 },
  "Demand-Refuge":          { color: "#84cc16", r: 5,  w: 1.0, fo: 0.80 },
  "Water Treatment Plant":  { color: "#06b6d4", r: 5,  w: 1.2, fo: 0.85 },
  "Wastewater Treatment Plant": { color: "#7c3aed", r: 5,  w: 1.2, fo: 0.85 },
};

export const DEFAULT_NODE_STYLE = { color: "#6b7280", r: 3, w: 0.5, fo: 0.55 };

/** Look up colour for a node_type (used by NeighborhoodGraph SVG). */
export const nodeColor = (nodeType) =>
  (NODE_STYLE[nodeType] || DEFAULT_NODE_STYLE).color;

// ---------------------------------------------------------------------------
// Arc styles  {color, w (weight), o? (opacity, default 0.75)}
// ---------------------------------------------------------------------------

export const ARC_STYLE = {
  "Channel":              { color: "#3b82f6", w: 2.8, o: 1.0 },
  "Diversion":            { color: "#34d399", w: 1.5 },
  "Inflow":               { color: "#2dd4bf", w: 1.5 },
  "Return Flow":          { color: "#a3e635", w: 1.2 },
  "Surface Runoff":       { color: "#86efac", w: 1.0 },
  "Seepage":              { color: "#94a3b8", w: 1.0 },
  "Tile Drain":           { color: "#b5a99a", w: 1.0 },
  "Evaporation":          { color: "#fbbf24", w: 0.8 },
  "Spill":                { color: "#7dd3fc", w: 1.2 },
  "Closure Term":         { color: "#9ca3af", w: 0.8 },
  "Delta Accretion":      { color: "#a78bfa", w: 1.2 },
  "Delta Depletion":      { color: "#f472b6", w: 1.2 },
};

export const DEFAULT_ARC_STYLE = { color: "#4b5563", w: 1.0 };
