/**
 * RegionalLayers — toggle control + GeoJSON rendering for regional overlays.
 *
 * Displays a collapsible control panel in the bottom-right of the map that lets
 * the user toggle regional polygon layers (watersheds, water budget areas,
 * demand units).
 *
 * Each layer is fetched lazily on first toggle via React Query and rendered
 * as a Leaflet GeoJSON overlay. When any regional layer is active the parent
 * NetworkMap mutes the network layer.
 *
 * Watershed click  → highlights polygon + selects its Inflow_arc in network
 * Demand unit click → highlights polygon + selects its DemandUnit_ID node
 */

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { GeoJSON } from "react-leaflet";
import { useQuery } from "@tanstack/react-query";
import L from "leaflet";
import { fetchOverlay } from "../api/client.js";

// ---------------------------------------------------------------------------
// Layer definitions — order here = render order in the toggle list
// ---------------------------------------------------------------------------

// Shared tooltip builder for all demand-unit sub-layers
const _demandTooltip = (p) => {
  const id = (p.DemandUnit_ID || "").trim();
  const name = p.WaterDistrictNAME || p.ServiceProviders_Name || "";
  const cls = p.Class || "";
  return (
    `<strong>${id}</strong>` +
    (name ? `<br/>${name}` : "") +
    (cls ? `<br/><em style="color:#9ca3af">${cls}</em>` : "")
  );
};
const _demandFeatureId = (p) => (p.DemandUnit_ID || "").trim().toUpperCase();

const REGIONAL_LAYERS = [
  {
    key: "watersheds",
    label: "Watersheds",
    color: "#38bdf8",       // sky-400
    tooltipFn: (p) => {
      const arc = p.Inflow_arc || "";
      const remark = p.Remarks || "";
      const type = p.Type || "";
      return (
        `<strong>${arc}</strong>` +
        (remark ? `<br/>${remark}` : "") +
        (type ? `<br/><em style="color:#9ca3af">${type}</em>` : "")
      );
    },
    // Returns the network feature_id to select when a polygon is clicked
    featureIdFn: (p) => (p.Inflow_arc || "").toUpperCase(),
  },
  {
    key: "water_budget",
    label: "Water Budget Areas",
    color: "#a78bfa",       // violet-400
    tooltipFn: (p) => {
      const id = p.WaterBudgetArea_ID || "";
      const region = p.HydroRegion || "";
      return (
        `<strong>WBA ${id}</strong>` +
        (region ? `<br/><em style="color:#9ca3af">${region}</em>` : "") +
        `<br/><span style="color:#a78bfa;font-size:10px">click for GW budget</span>`
      );
    },
    featureIdFn: (p) => (p.WaterBudgetArea_ID || "").trim(),
    isWba: true,  // flag to route clicks to onWbaClick instead of onNetworkSelect
  },
  // --- Demand units split by Class (all fetch the same GeoJSON, filtered client-side) ---
  {
    key: "demand_unit_ag",
    apiKey: "demand_unit",          // shared fetch key → single cached request
    label: "Demand – Ag",
    color: "#eab308",               // yellow-500 (matches Demand-Agricultural node)
    filterFn: (p) => p.Class === "Agriculture" || p.Class === "N/A",
    tooltipFn: _demandTooltip,
    featureIdFn: _demandFeatureId,
  },
  {
    key: "demand_unit_urban",
    apiKey: "demand_unit",
    label: "Demand – Urban",
    color: "#f43f5e",               // rose-500 (matches Demand-Urban node)
    filterFn: (p) => p.Class === "Urban",
    tooltipFn: _demandTooltip,
    featureIdFn: _demandFeatureId,
  },
  {
    key: "demand_unit_refuge",
    apiKey: "demand_unit",
    label: "Demand – Refuge",
    color: "#84cc16",               // lime-500 (matches Demand-Refuge node)
    filterFn: (p) => p.Class === "Refuge",
    tooltipFn: _demandTooltip,
    featureIdFn: _demandFeatureId,
  },
];

// ---------------------------------------------------------------------------
// Individual overlay renderer
// ---------------------------------------------------------------------------

function OverlayLayer({ layerKey, apiKey, color, tooltipFn, featureIdFn, filterFn, isWba, onNetworkSelect, onWbaSelect, selectedPolygonId }) {
  const fetchKey = apiKey || layerKey;
  const { data: rawData, isLoading } = useQuery({
    queryKey: ["overlay", fetchKey],
    queryFn: () => fetchOverlay(fetchKey),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // Apply optional class filter client-side (shared GeoJSON, different sub-layers)
  const data = useMemo(() => {
    if (!rawData || !filterFn) return rawData;
    return {
      ...rawData,
      features: (rawData.features || []).filter((f) => filterFn(f.properties || {})),
    };
  }, [rawData, filterFn]);

  const layerRef = useRef(null);

  // Update polygon highlight style reactively when selectedPolygonId changes
  useEffect(() => {
    if (!layerRef.current) return;
    layerRef.current.eachLayer((layer) => {
      if (!layer.feature) return;
      const fid = featureIdFn ? featureIdFn(layer.feature.properties) : null;
      const isActive = fid && selectedPolygonId && fid === selectedPolygonId;
      layer.setStyle({
        color: isActive ? "#facc15" : color,
        weight: isActive ? 3 : 1.2,
        opacity: isActive ? 1 : 0.7,
        fillColor: isActive ? "#facc15" : color,
        fillOpacity: isActive ? 0.25 : 0.12,
      });
      if (isActive && layer.bringToFront) layer.bringToFront();
    });
  }, [selectedPolygonId, color, featureIdFn]);

  if (isLoading || !data) return null;

  const style = () => ({
    color,
    weight: 1.2,
    opacity: 0.7,
    fillColor: color,
    fillOpacity: 0.12,
  });

  const onEachFeature = (feature, layer) => {
    const props = feature.properties || {};
    const html = tooltipFn ? tooltipFn(props) : "";
    if (html) {
      layer.bindTooltip(html, {
        sticky: true,
        className: "calsim-tooltip",
        direction: "top",
        offset: [0, -4],
      });
    }

    layer.on("click", (e) => {
      // Stop propagation so the map doesn't also fire a click
      L.DomEvent.stopPropagation(e);
      // Select associated network feature (arc or node) or WBA
      if (featureIdFn) {
        const fid = featureIdFn(props);
        if (fid) {
          if (isWba && onWbaSelect) {
            onWbaSelect(fid);
          } else if (onNetworkSelect) {
            onNetworkSelect(fid);
          }
        }
      }
    });
  };

  return (
    <GeoJSON
      ref={layerRef}
      key={layerKey}
      data={data}
      style={style}
      onEachFeature={onEachFeature}
      pointToLayer={(_, latlng) => L.circleMarker(latlng, { radius: 3 })}
    />
  );
}

// ---------------------------------------------------------------------------
// Toggle control panel (positioned in the map's top-right area)
// ---------------------------------------------------------------------------

export default function RegionalLayers({ activeLayers, onToggle, onHighlightFeatures, onFeatureClick, onWbaClick }) {
  const [open, setOpen] = useState(false);
  const [selectedPolygonId, setSelectedPolygonId] = useState(null);

  // -----------------------------------------------------------------------
  // Fetch watershed + demand_unit data for highlight extraction
  // -----------------------------------------------------------------------
  const watershedsActive = activeLayers.includes("watersheds");
  const demandUnitsActive =
    activeLayers.includes("demand_unit_ag") ||
    activeLayers.includes("demand_unit_urban") ||
    activeLayers.includes("demand_unit_refuge");

  const { data: wsData } = useQuery({
    queryKey: ["overlay", "watersheds"],
    queryFn: () => fetchOverlay("watersheds"),
    staleTime: Infinity,
    gcTime: Infinity,
    enabled: watershedsActive,
  });

  const { data: duData } = useQuery({
    queryKey: ["overlay", "demand_unit"],
    queryFn: () => fetchOverlay("demand_unit"),
    staleTime: Infinity,
    gcTime: Infinity,
    enabled: demandUnitsActive,
  });

  // Build combined highlight set: arc IDs from watersheds + node IDs from demand units
  const highlightSet = useMemo(() => {
    const ids = new Set();
    if (watershedsActive && wsData) {
      for (const f of wsData.features || []) {
        const arc = f.properties?.Inflow_arc;
        if (arc) ids.add(arc.toUpperCase());
      }
    }
    if (demandUnitsActive && duData) {
      // Only unmute nodes whose Class matches the currently-active sub-layers
      const activeFilterFns = REGIONAL_LAYERS
        .filter(({ filterFn, key }) => filterFn && activeLayers.includes(key))
        .map(({ filterFn }) => filterFn);
      for (const f of duData.features || []) {
        const props = f.properties || {};
        if (!activeFilterFns.some((fn) => fn(props))) continue;
        const du = (props.DemandUnit_ID || "").trim();
        if (du) ids.add(du.toUpperCase());
      }
    }
    return ids.size > 0 ? ids : null;
  }, [watershedsActive, wsData, demandUnitsActive, duData, activeLayers]);

  useEffect(() => {
    if (onHighlightFeatures) onHighlightFeatures(highlightSet);
  }, [highlightSet]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear polygon selection when layers are toggled off
  useEffect(() => {
    if (activeLayers.length === 0) setSelectedPolygonId(null);
  }, [activeLayers]);

  // When a polygon is clicked, select it locally AND tell NetworkMap
  const handleNetworkSelect = useCallback((fid) => {
    setSelectedPolygonId(fid);
    if (onFeatureClick) onFeatureClick(fid);
  }, [onFeatureClick]);

  // When a WBA polygon is clicked, select it and open GW budget panel
  const handleWbaSelect = useCallback((wbaId) => {
    setSelectedPolygonId(wbaId);
    if (onWbaClick) onWbaClick(wbaId);
  }, [onWbaClick]);

  return (
    <>
      {/* Control panel — bottom-right, near legend */}
      <div
        className="absolute bottom-8 right-3 z-[1000]"
        style={{ backdropFilter: "blur(4px)" }}
      >
        <button
          onClick={() => setOpen((o) => !o)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
            activeLayers.length > 0
              ? "bg-indigo-600/90 text-white border border-indigo-400/40"
              : "bg-gray-900/80 text-gray-300 border border-gray-700 hover:border-gray-500"
          }`}
          title="Toggle regional layers"
        >
          {/* layer icon */}
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
            <path d="M1 12.5A4.5 4.5 0 005.5 17H15a4 4 0 001.866-7.539 3.504 3.504 0 00-4.504-4.272A4.5 4.5 0 004.06 8.235 4.502 4.502 0 001 12.5z" />
          </svg>
          Regions
          {activeLayers.length > 0 && (
            <span className="ml-0.5 bg-white/20 rounded-full px-1.5 text-[10px]">
              {activeLayers.length}
            </span>
          )}
        </button>

        {open && (
          <div className="absolute bottom-full mb-1 right-0 bg-gray-900/90 border border-gray-700 rounded p-2 text-xs text-gray-300 min-w-[180px]">
            {REGIONAL_LAYERS.map(({ key, label, color }) => {
              const active = activeLayers.includes(key);
              return (
                <button
                  key={key}
                  onClick={() => onToggle(key)}
                  className={`flex items-center gap-2 w-full text-left rounded px-1.5 py-1 transition-colors ${
                    active ? "bg-white/10" : "hover:bg-white/5"
                  }`}
                >
                  {/* color swatch */}
                  <span
                    className="flex-shrink-0 w-3 h-3 rounded-sm border"
                    style={{
                      background: active ? color : "transparent",
                      borderColor: color,
                      opacity: active ? 1 : 0.5,
                    }}
                  />
                  <span className={active ? "text-white font-medium" : "text-gray-400"}>
                    {label}
                  </span>
                </button>
              );
            })}

            {activeLayers.length > 0 && (
              <button
                onClick={() => activeLayers.forEach((k) => onToggle(k))}
                className="mt-1.5 w-full text-[10px] text-gray-500 hover:text-gray-300 border border-gray-700 hover:border-gray-500 rounded px-1 py-0.5 transition-colors"
              >
                clear all
              </button>
            )}
          </div>
        )}
      </div>

      {/* Render active overlay layers inside the map */}
      {REGIONAL_LAYERS.filter(({ key }) => activeLayers.includes(key)).map(
        ({ key, apiKey, color, tooltipFn, featureIdFn, filterFn, isWba }) => (
          <OverlayLayer
            key={key}
            layerKey={key}
            apiKey={apiKey}
            color={color}
            tooltipFn={tooltipFn}
            featureIdFn={featureIdFn}
            filterFn={filterFn}
            isWba={isWba}
            onNetworkSelect={handleNetworkSelect}
            onWbaSelect={handleWbaSelect}
            selectedPolygonId={selectedPolygonId}
          />
        )
      )}
    </>
  );
}
