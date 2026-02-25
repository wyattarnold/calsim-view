import { useEffect, useRef, useState } from "react";
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
  "Reservoir":              { color: "#3b82f6", r: 9,  w: 1.5, fo: 0.92 },
  "Demand-Agricultural":    { color: "#eab308", r: 6,  w: 1.2, fo: 0.85 },
  "Demand-Urban":           { color: "#f43f5e", r: 6,  w: 1.2, fo: 0.85 },
  "Demand-Refuge":          { color: "#84cc16", r: 5,  w: 1.0, fo: 0.80 },
  "Water Treatment Plant":  { color: "#06b6d4", r: 5,  w: 1.2, fo: 0.85 },
  "Wastewater Treatment Plant": { color: "#7c3aed", r: 5,  w: 1.2, fo: 0.85 },
};

const DEFAULT_NODE_STYLE = { color: "#6b7280", r: 3, w: 0.5, fo: 0.55 };

// LineString arc styles: {color, w, o?}  (o defaults to 0.75)
const ARC_STYLE = {
  "Channel":              { color: "#3b82f6", w: 2.8, o: 1.0 }, // vivid blue, thick, full opacity
  "Diversion":            { color: "#34d399", w: 1.5 },   // emerald
  "Inflow":               { color: "#2dd4bf", w: 1.5 },   // teal
  "Return Flow":          { color: "#a3e635", w: 1.2 },   // lime
  "Surface Runoff":       { color: "#86efac", w: 1.0 },   // light green
  "Seepage":              { color: "#94a3b8", w: 1.0 },   // light slate-blue
  "Tile Drain":           { color: "#b5a99a", w: 1.0 },   // warm stone
  "Evaporation":          { color: "#fbbf24", w: 0.8 },   // amber
  "Spill":                { color: "#7dd3fc", w: 1.2 },   // pale sky
  "Closure Term":         { color: "#9ca3af", w: 0.8 },   // medium gray
  "Delta Accretion":      { color: "#a78bfa", w: 1.2 },   // violet
  "Delta Depletion":      { color: "#f472b6", w: 1.2 },   // pink
};

const DEFAULT_ARC_STYLE = { color: "#4b5563", w: 1.0 };

const ARROW_MIN_ZOOM = 11;

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

function nodePointStyle(feature, selectedFeature, highlightType) {
  const { feature_id, node_type } = feature.properties;
  const isSelected = feature_id === selectedFeature;
  const ns = NODE_STYLE[node_type] || DEFAULT_NODE_STYLE;
  const dimmed = highlightType && node_type !== highlightType && !isSelected;

  return {
    radius: isSelected ? ns.r + 4 : ns.r,
    fillColor: ns.color,
    color: isSelected ? "#ffffff" : "#111827",
    weight: isSelected ? 2.5 : ns.w,
    opacity: dimmed ? 0.15 : 1,
    fillOpacity: isSelected ? 1 : dimmed ? 0.08 : ns.fo,
  };
}

function arcLineStyle(feature, selectedFeature, highlightType) {
  const { feature_id, arc_type } = feature.properties;
  const isSelected = feature_id === selectedFeature;
  const as = ARC_STYLE[arc_type] || DEFAULT_ARC_STYLE;
  const dimmed = highlightType && arc_type !== highlightType && !isSelected;

  const baseOpacity = as.o ?? 0.75;
  return {
    color: isSelected ? "#facc15" : as.color,
    weight: isSelected ? as.w + 1.5 : as.w,
    opacity: isSelected ? 1.0 : dimmed ? 0.08 : baseOpacity,
  };
}

function featureStyle(feature, selectedFeature, highlightType) {
  const { feature_kind } = feature.properties;
  if (feature_kind === "node") return nodePointStyle(feature, selectedFeature, highlightType);
  return arcLineStyle(feature, selectedFeature, highlightType);
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

function GeoJSONLayer({ geojson, selectedFeature, highlightType, onFeatureClick }) {
  const layerRef = useRef(null);
  const map = useMap();
  const [mapZoom, setMapZoom] = useState(() => map.getZoom());
  const [moveSeq, setMoveSeq] = useState(0);

  useEffect(() => {
    const onZoom = () => setMapZoom(map.getZoom());
    const onMove = () => setMoveSeq((s) => s + 1);
    map.on("zoomend", onZoom);
    map.on("moveend", onMove);
    return () => { map.off("zoomend", onZoom); map.off("moveend", onMove); };
  }, [map]);

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
    const showArrows = mapZoom >= ARROW_MIN_ZOOM;
    layerRef.current.eachLayer((layer) => {
      if (!layer.feature || !layer.setStyle) return;
      layer.setStyle(featureStyle(layer.feature, selectedFeature, highlightType));
      // leaflet-arrowheads renders separate SVG layers — update their opacity independently
      if (layer._arrowheads) {
        const { feature_id, arc_type } = layer.feature.properties;
        const isSelected = feature_id === selectedFeature;
        const dimmed = highlightType && arc_type !== highlightType && !isSelected;
        const arrowOpacity = !showArrows ? 0 : isSelected ? 1.0 : dimmed ? 0.08 : 0.75;
        layer._arrowheads.eachLayer((ah) =>
          ah.setStyle({ opacity: arrowOpacity, fillOpacity: arrowOpacity })
        );
      }
      if (
        layer.feature.properties.feature_id === selectedFeature &&
        layer.bringToFront
      ) {
        layer.bringToFront();
      }
    });
  }, [selectedFeature, highlightType, mapZoom, moveSeq]);

  if (!geojson) return null;

  return (
    <GeoJSON
      ref={layerRef}
      data={geojson}
      style={(feature) => featureStyle(feature, selectedFeature, highlightType)}
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

function Legend({ highlightType, onHighlight }) {
  return (
    <div
      className="absolute bottom-8 left-3 z-[1000] bg-gray-900/90 border border-gray-700 rounded p-2 text-xs text-gray-300"
      style={{ backdropFilter: "blur(4px)", maxHeight: "calc(100vh - 120px)", overflowY: "auto" }}
    >
      <p className="font-semibold text-gray-400 mb-1.5">Nodes</p>
      {Object.entries(NODE_STYLE).map(([type, { color, r }]) => {
        const active = highlightType === type;
        return (
          <button
            key={type}
            onClick={() => onHighlight(active ? null : type)}
            className={`flex items-center gap-1.5 mb-0.5 w-full text-left rounded px-0.5 transition-colors ${
              active ? "bg-white/10" : "hover:bg-white/5"
            }`}
          >
            <span style={{
              display: "inline-block",
              width: Math.max(r * 2, 6), height: Math.max(r * 2, 6),
              borderRadius: "50%", background: color, flexShrink: 0,
              outline: active ? `2px solid ${color}` : "none", outlineOffset: 1,
            }} />
            <span className={`text-[10px] ${active ? "text-white font-semibold" : "text-gray-400"}`}>{type}</span>
          </button>
        );
      })}
      <p className="font-semibold text-gray-400 mt-2 mb-1.5">Arcs</p>
      {Object.entries(ARC_STYLE).map(([type, { color }]) => {
        const active = highlightType === type;
        return (
          <button
            key={type}
            onClick={() => onHighlight(active ? null : type)}
            className={`flex items-center gap-1.5 mb-0.5 w-full text-left rounded px-0.5 transition-colors ${
              active ? "bg-white/10" : "hover:bg-white/5"
            }`}
          >
            <span style={{
              display: "inline-block", width: 16, height: active ? 3 : 2,
              background: color, flexShrink: 0, borderRadius: 1,
            }} />
            <span className={`text-[10px] ${active ? "text-white font-semibold" : "text-gray-400"}`}>{type}</span>
          </button>
        );
      })}
      {highlightType && (
        <button
          onClick={() => onHighlight(null)}
          className="mt-2 w-full text-[10px] text-gray-500 hover:text-gray-300 border border-gray-700 hover:border-gray-500 rounded px-1 py-0.5 transition-colors"
        >
          clear filter
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default function NetworkMap({ selectedFeature, flyToFeature, onFeatureClick }) {
  const [highlightType, setHighlightType] = useState(null);
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
              highlightType={highlightType}
              onFeatureClick={onFeatureClick}
            />
            <MapResizeHandler />
            <MapFlyTo featureId={flyToFeature} geojson={geojson} />
          </>
        )}
      </MapContainer>
      <Legend highlightType={highlightType} onHighlight={setHighlightType} />
    </div>
  );
}
