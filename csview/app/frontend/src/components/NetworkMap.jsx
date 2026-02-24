import { useEffect, useRef } from "react";
import { MapContainer, TileLayer, GeoJSON, useMap } from "react-leaflet";
import { useQuery } from "@tanstack/react-query";
import L from "leaflet";
import "leaflet-arrowheads";
import { fetchNetwork } from "../api/client.js";

// Fix Leaflet default icon paths broken by Vite bundling
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

// ---------------------------------------------------------------------------
// Visual style tables — CalSim 3 node types
// ---------------------------------------------------------------------------

// Point nodes: circle marker styles  {color, radius (r), stroke weight (w), fillOpacity (fo)}
const NODE_STYLE = {
  "Reservoir":            { color: "#3b82f6", r: 9,  w: 1.5, fo: 0.92 },
  "Groundwater":          { color: "#10b981", r: 6,  w: 1.2, fo: 0.80 },
  "Groundwater Storage":  { color: "#059669", r: 8,  w: 1.5, fo: 0.88 },
  "Demand-Agricultural":  { color: "#f59e0b", r: 6,  w: 1.2, fo: 0.85 },
  "Demand-Urban":         { color: "#f97316", r: 6,  w: 1.2, fo: 0.85 },
  "Demand-Refuge":        { color: "#84cc16", r: 5,  w: 1.0, fo: 0.80 },
  "Shortage":             { color: "#ef4444", r: 5,  w: 1.2, fo: 0.85 },
  "Contract":             { color: "#eab308", r: 4,  w: 1.0, fo: 0.80 },
  "Return Flow":          { color: "#a3e635", r: 4,  w: 1.0, fo: 0.75 },
  "Evaporation":          { color: "#475569", r: 3,  w: 0.5, fo: 0.55 },
  "Water Quality":        { color: "#22d3ee", r: 4,  w: 0.8, fo: 0.70 },
  "Power":                { color: "#a855f7", r: 5,  w: 1.0, fo: 0.80 },
};

const DEFAULT_NODE_STYLE = { color: "#6b7280", r: 3, w: 0.5, fo: 0.55 };

// LineString arc nodes: {color, weight}
const ARC_STYLE = {
  "Channel":              { color: "#60a5fa", w: 1.8 },   // light blue
  "Diversion":            { color: "#34d399", w: 1.5 },   // emerald
  "Inflow":               { color: "#2dd4bf", w: 1.5 },   // teal
  "Return Flow":          { color: "#a3e635", w: 1.2 },   // lime
  "Minimum Flow":         { color: "#38bdf8", w: 1.2 },   // sky
  "Surface Runoff":       { color: "#86efac", w: 1.0 },   // light green
  "Seepage":              { color: "#64748b", w: 1.0 },   // slate
  "Deep Percolation":     { color: "#6b7280", w: 1.0 },   // gray
  "Tile Drain":           { color: "#78716c", w: 1.0 },   // stone
  "Groundwater":          { color: "#059669", w: 1.2 },   // green
  "Evaporation":          { color: "#475569", w: 0.8 },   // dark slate
  "Spill":                { color: "#7dd3fc", w: 1.2 },   // pale sky
  "Closure Term":         { color: "#4b5563", w: 0.8 },   // gray
  "Delta Accretion":      { color: "#a78bfa", w: 1.2 },   // violet
  "Delta Depletion":      { color: "#f472b6", w: 1.2 },   // pink
};

const DEFAULT_ARC_STYLE = { color: "#4b5563", w: 1.0 };

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

function nodePointStyle(feature, selectedFeature) {
  const { feature_id, node_type } = feature.properties;
  const isSelected = feature_id === selectedFeature;
  const ns = NODE_STYLE[node_type] || DEFAULT_NODE_STYLE;

  return {
    radius: isSelected ? ns.r + 4 : ns.r,
    fillColor: ns.color,
    color: isSelected ? "#ffffff" : "#111827",
    weight: isSelected ? 2.5 : ns.w,
    opacity: 1,
    fillOpacity: isSelected ? 1 : ns.fo,
  };
}

function arcLineStyle(feature, selectedFeature) {
  const { feature_id, arc_type } = feature.properties;
  const isSelected = feature_id === selectedFeature;
  const as = ARC_STYLE[arc_type] || DEFAULT_ARC_STYLE;

  return {
    color: isSelected ? "#facc15" : as.color,
    weight: isSelected ? as.w + 1.5 : as.w,
    opacity: isSelected ? 1.0 : 0.75,
  };
}

function featureStyle(feature, selectedFeature) {
  const { feature_kind } = feature.properties;

  if (feature_kind === "node") {
    return nodePointStyle(feature, selectedFeature);
  }
  // feature_kind === "arc"
  return arcLineStyle(feature, selectedFeature);
}

function pointToLayer(feature, latlng) {
  return L.circleMarker(latlng);
}

// ---------------------------------------------------------------------------
// Map helpers
// ---------------------------------------------------------------------------

function MapResizeHandler() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false }));
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);
  return null;
}

function MapFlyTo({ featureId, geojson }) {
  const map = useMap();
  useEffect(() => {
    if (!featureId || !geojson) return;
    const feature = geojson.features.find(
      (f) => f.properties.feature_id === featureId
    );
    if (!feature) return;

    let lat, lng;
    const geom = feature.geometry;
    if (geom?.type === "Point") {
      [lng, lat] = geom.coordinates;
    } else if (geom?.type === "LineString" && geom.coordinates?.length) {
      const mid = geom.coordinates[Math.floor(geom.coordinates.length / 2)];
      [lng, lat] = mid;
    } else {
      return;
    }

    let raf1, raf2;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        map.invalidateSize({ animate: false });
        map.flyTo([lat, lng], Math.max(map.getZoom(), 9), { duration: 0.8 });
      });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [featureId]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// ---------------------------------------------------------------------------
// GeoJSON Layer — mounted once, styles updated reactively
// ---------------------------------------------------------------------------

function GeoJSONLayer({ geojson, selectedFeature, onFeatureClick }) {
  const layerRef = useRef(null);
  const map = useMap();

  // Fit California bounds on first load
  useEffect(() => {
    if (layerRef.current) {
      try {
        const bounds = layerRef.current.getBounds();
        if (bounds.isValid()) map.fitBounds(bounds, { padding: [20, 20] });
      } catch {}
    }
  }, [geojson]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reactively update styles without remounting
  useEffect(() => {
    if (!layerRef.current) return;
    layerRef.current.eachLayer((layer) => {
      if (!layer.feature || !layer.setStyle) return;
      layer.setStyle(featureStyle(layer.feature, selectedFeature));
      if (
        layer.feature.properties.feature_id === selectedFeature &&
        layer.bringToFront
      ) {
        layer.bringToFront();
      }
    });
  }, [selectedFeature]);

  if (!geojson) return null;

  return (
    <GeoJSON
      ref={layerRef}
      data={geojson}
      style={(feature) => featureStyle(feature, selectedFeature)}
      pointToLayer={pointToLayer}
      onEachFeature={(feature, layer) => {
        const { feature_id, node_type, arc_type, feature_kind, description, name } = feature.properties;
        const typeLabel = node_type || arc_type || "";
        const dispName = description || name || "";
        layer.bindTooltip(
          `<strong>${feature_id}</strong>` +
          (dispName ? `<br/>${dispName}` : "") +
          (typeLabel ? `<br/><em style="color:#9ca3af">${typeLabel}</em>` : ""),
          { sticky: false, className: "calsim-tooltip", direction: "top", offset: [0, -4] }
        );

        if (feature_kind === "arc") {
          // Direction arrow at the downstream end of each arc
          layer.arrowheads({ size: "8px", frequency: "endonly", yawn: 35, fill: true });
          // Delay tooltip appearance so thin lines aren't triggered by passing cursor
          layer.off("mouseover", layer._openTooltip, layer);
          let _hoverTimer = null;
          layer.on("mouseover", () => {
            _hoverTimer = setTimeout(() => layer.openTooltip(), 220);
          });
          layer.on("mouseout", () => clearTimeout(_hoverTimer));
        }

        layer.on("click", () => onFeatureClick(feature_id));
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Map legend
// ---------------------------------------------------------------------------

function Legend() {
  return (
    <div
      className="absolute bottom-8 left-3 z-[1000] bg-gray-900/90 border border-gray-700 rounded p-2 text-xs text-gray-300 pointer-events-none"
      style={{ backdropFilter: "blur(4px)", maxHeight: "calc(100vh - 120px)", overflowY: "auto" }}
    >
      <p className="font-semibold text-gray-400 mb-1.5">Nodes</p>
      {Object.entries(NODE_STYLE).map(([type, { color, r }]) => (
        <div key={type} className="flex items-center gap-1.5 mb-0.5">
          <span style={{
            display: "inline-block",
            width: Math.max(r * 2, 6),
            height: Math.max(r * 2, 6),
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
          }} />
          <span className="text-gray-400 text-[10px]">{type}</span>
        </div>
      ))}
      <p className="font-semibold text-gray-400 mt-2 mb-1.5">Arcs</p>
      {Object.entries(ARC_STYLE).map(([type, { color }]) => (
        <div key={type} className="flex items-center gap-1.5 mb-0.5">
          <span style={{ display: "inline-block", width: 16, height: 2, background: color, flexShrink: 0, borderRadius: 1 }} />
          <span className="text-gray-400 text-[10px]">{type}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default function NetworkMap({ selectedFeature, flyToFeature, onFeatureClick }) {
  const { data: geojson, isLoading } = useQuery({
    queryKey: ["network"],
    queryFn: fetchNetwork,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        Loading network…
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={[37.5, -120.0]}
        zoom={6}
        className="h-full w-full"
        zoomControl={true}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          opacity={0.35}
        />
        {geojson && (
          <>
            <GeoJSONLayer
              geojson={geojson}
              selectedFeature={selectedFeature}
              onFeatureClick={onFeatureClick}
            />
            <MapResizeHandler />
            <MapFlyTo featureId={flyToFeature} geojson={geojson} />
          </>
        )}
      </MapContainer>
      <Legend />
    </div>
  );
}
