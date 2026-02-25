import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchFeature, fetchFeatureResults } from "../api/client.js";
import ResultsChart from "./ResultsChart.jsx";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MetaRow({ label, value }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div className="flex gap-2 text-sm">
      <span className="text-gray-400 shrink-0 w-36">{label}</span>
      <span className="text-gray-100 break-all">{String(value)}</span>
    </div>
  );
}

function Section({ title, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-3 border-b border-gray-700 pb-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 w-full text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300 mb-2 px-4"
      >
        <span className="text-gray-600">{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open && <div className="px-4">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Year range slider
// ---------------------------------------------------------------------------

const DROUGHT_PRESETS = [
  { label: "1928–37", start: "1928", end: "1937" },
  { label: "1976–77", start: "1976", end: "1977" },
  { label: "1987–92", start: "1987", end: "1992" },
];

function YearRangeSlider({ years, startIdx, endIdx, onStartChange, onEndChange }) {
  const [nearStart, setNearStart] = useState(false);
  const dragRef = useRef(null); // { startX, startStartIdx, startEndIdx, trackWidth }

  if (years.length === 0) return null;
  const max = years.length - 1;
  const startPct = max > 0 ? (startIdx / max) * 100 : 0;
  const endPct   = max > 0 ? (endIdx   / max) * 100 : 100;

  function handleTrackPointerMove(e) {
    if (dragRef.current) return; // don't flip nearStart while panning
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const startFrac = max > 0 ? startIdx / max : 0;
    const endFrac   = max > 0 ? endIdx   / max : 1;
    setNearStart(Math.abs(x - startFrac) <= Math.abs(x - endFrac));
  }

  function handleCenterPointerDown(e) {
    e.preventDefault();
    e.stopPropagation();
    const trackEl = e.currentTarget.parentElement;
    const rect = trackEl.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startStartIdx: startIdx,
      startEndIdx: endIdx,
      trackWidth: rect.width,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handleCenterPointerMove(e) {
    if (!dragRef.current) return;
    const { startX, startStartIdx, startEndIdx, trackWidth } = dragRef.current;
    const window = startEndIdx - startStartIdx;
    const deltaFrac = (e.clientX - startX) / trackWidth;
    const deltaIdx = Math.round(deltaFrac * max);
    let newStart = startStartIdx + deltaIdx;
    let newEnd   = startEndIdx   + deltaIdx;
    // clamp so window doesn't go out of bounds
    if (newStart < 0)   { newEnd -= newStart;   newStart = 0; }
    if (newEnd   > max) { newStart -= (newEnd - max); newEnd = max; }
    newStart = Math.max(0, newStart);
    newEnd   = Math.min(max, newEnd);
    if (newEnd - newStart === window) {
      onStartChange(newStart);
      onEndChange(newEnd);
    }
  }

  function handleCenterPointerUp(e) {
    dragRef.current = null;
  }

  function applyPreset(startYear, endYear) {
    const si = years.findIndex((y) => y >= startYear);
    let ei = -1;
    for (let i = years.length - 1; i >= 0; i--) {
      if (years[i] <= endYear) { ei = i; break; }
    }
    if (si >= 0 && ei > si) { onStartChange(si); onEndChange(ei); }
  }

  return (
    <div className="shrink-0 border-t border-gray-700 px-4 py-2 space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-gray-600 shrink-0">Dry periods:</span>
        {DROUGHT_PRESETS.map((p) => {
          const si = years.findIndex((y) => y >= p.start);
          let ei = -1;
          for (let i = years.length - 1; i >= 0; i--) {
            if (years[i] <= p.end) { ei = i; break; }
          }
          const active = si >= 0 && ei >= 0 && startIdx === si && endIdx === ei;
          return (
            <button
              key={p.label}
              onClick={() => applyPreset(p.start, p.end)}
              className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                active
                  ? "border-blue-500 text-blue-400 bg-blue-950"
                  : "border-gray-600 text-gray-400 hover:border-blue-400 hover:text-blue-400"
              }`}
            >
              {p.label}
            </button>
          );
        })}
        <button
          onClick={() => { onStartChange(0); onEndChange(max); }}
          className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ml-auto ${
            startIdx === 0 && endIdx === max
              ? "border-gray-500 text-gray-400"
              : "border-gray-700 text-gray-500 hover:border-gray-500 hover:text-gray-400"
          }`}
        >
          All
        </button>
      </div>

      <div>
        <div className="flex justify-between text-[10px] font-mono text-gray-400 mb-1">
          <span>{years[startIdx]}</span>
          <span>{years[endIdx]}</span>
        </div>
        <div className="relative h-5" onPointerMove={handleTrackPointerMove}>
          <div className="absolute top-1/2 -translate-y-1/2 w-full h-1.5 rounded-full bg-gray-700 pointer-events-none">
            <div
              className="absolute h-full rounded-full bg-blue-500"
              style={{ left: `${startPct}%`, right: `${100 - endPct}%` }}
            />
          </div>
          <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-blue-400 border border-gray-900 pointer-events-none"
            style={{ left: `calc(${startPct}% - 6px)`, zIndex: 10 }}
          />
          <div
            className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-blue-400 border border-gray-900 pointer-events-none"
            style={{ left: `calc(${endPct}% - 6px)`, zIndex: 10 }}
          />
          {/* Center grab zone — drag to pan the whole window */}
          <div
            className="absolute top-1/2 -translate-y-1/2 h-3"
            style={{
              left: `${startPct}%`,
              right: `${100 - endPct}%`,
              zIndex: 6,
              cursor: dragRef.current ? "grabbing" : "grab",
            }}
            onPointerDown={handleCenterPointerDown}
            onPointerMove={handleCenterPointerMove}
            onPointerUp={handleCenterPointerUp}
            onPointerCancel={handleCenterPointerUp}
          />
          <input
            type="range" min={0} max={max} value={startIdx}
            onChange={(e) => onStartChange(Math.min(Number(e.target.value), endIdx - 1))}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            style={{ zIndex: nearStart ? 5 : 3 }}
          />
          <input
            type="range" min={0} max={max} value={endIdx}
            onChange={(e) => onEndChange(Math.max(Number(e.target.value), startIdx + 1))}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            style={{ zIndex: nearStart ? 3 : 5 }}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function NodePanel({ featureId, activeStudy, onClose, graphOpen, onToggleGraph }) {
  const [startIdx, setStartIdx] = useState(0);
  const [endIdx, setEndIdx] = useState(0);
  const sliderInitialized = useRef(false);

  const { data: feature, isLoading: nodeLoading } = useQuery({
    queryKey: ["feature", featureId],
    queryFn: () => fetchFeature(featureId),
    enabled: !!featureId,
  });

  const { data: results, isLoading: resultsLoading } = useQuery({
    queryKey: ["featureResults", featureId, activeStudy],
    queryFn: () => fetchFeatureResults(featureId, activeStudy),
    enabled: !!featureId,
  });

  // Derive sorted unique years from any result series
  const years = useMemo(() => {
    if (!results?.series) return [];
    const firstKey = Object.keys(results.series)[0];
    if (!firstKey) return [];
    const yearSet = new Set(
      results.series[firstKey]
        .map((row) => String(row[0]).slice(0, 4))
        .filter((y) => /^\d{4}$/.test(y))
    );
    return Array.from(yearSet).sort();
  }, [results]);

  useEffect(() => {
    sliderInitialized.current = false;
  }, [featureId]);

  useEffect(() => {
    if (years.length > 0 && !sliderInitialized.current) {
      setStartIdx(0);
      setEndIdx(years.length - 1);
      sliderInitialized.current = true;
    }
  }, [years.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const dateRange = years.length > 0
    ? [years[Math.min(startIdx, years.length - 1)], years[Math.min(endIdx, years.length - 1)]]
    : null;

  if (!featureId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm px-6 text-center">
        <p className="text-2xl mb-3">🗺</p>
        <p>Click a feature on the map to see its details.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 shrink-0">
        <div className="min-w-0">
          <h2 className="font-mono text-blue-400 font-semibold truncate">{featureId}</h2>
          {feature && (
            <p className="text-xs text-gray-400 truncate">
              {feature.node_type || feature.arc_type || feature.feature_kind}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 ml-2 shrink-0">
          {onToggleGraph && (
            <button
              onClick={onToggleGraph}
              title={graphOpen ? "Hide network graph" : "Show network graph"}
              className="text-gray-500 hover:text-gray-200 text-xs px-1.5 py-0.5 border border-gray-700 rounded transition-colors hover:border-gray-500"
            >
              {graphOpen ? "⟨" : "⟩"}
            </button>
          )}
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 text-xl leading-none"
            aria-label="Close panel"
          >
            ×
          </button>
        </div>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto py-3">
        {nodeLoading ? (
          <p className="px-4 text-gray-500 text-sm">Loading…</p>
        ) : feature ? (
          <>
            <Section title="Properties">
              <div className="space-y-1">
                <MetaRow label="Description" value={feature.description} />
                <MetaRow label="Feature Kind" value={feature.feature_kind} />
                <MetaRow label="Type" value={feature.node_type || feature.arc_type} />
                <MetaRow label="Units" value={feature.units} />
                <MetaRow label="Hydro Region" value={feature.hydro_region} />
              </div>
            </Section>

            {/* Node geographic / hydrologic metadata */}
            {feature.feature_kind === "node" && (feature.river_name || feature.nearest_gage || feature.stream_code || feature.river_mile != null) && (
              <Section title="Geographic" defaultOpen={false}>
                <div className="space-y-1">
                  <MetaRow label="River / Water Body" value={feature.river_name} />
                  <MetaRow label="Nearest Gage" value={feature.nearest_gage} />
                  <MetaRow label="Stream Code" value={feature.stream_code} />
                  <MetaRow
                    label="River Mile"
                    value={feature.river_mile != null ? feature.river_mile.toFixed(1) : null}
                  />
                  <MetaRow label="CalSim 2 ID" value={feature.calsim2_id} />
                  <MetaRow label="Longitude" value={feature.lon?.toFixed(4)} />
                  <MetaRow label="Latitude" value={feature.lat?.toFixed(4)} />
                </div>
              </Section>
            )}

            {/* Arc topology */}
            {feature.feature_kind === "arc" && (feature.from_node || feature.to_node) && (
              <Section title="Arc Details" defaultOpen={false}>
                <div className="space-y-1">
                  <MetaRow label="Name" value={feature.name} />
                  <MetaRow label="Arc Type" value={feature.arc_type} />
                  <MetaRow label="Sub-Type" value={feature.sub_type} />
                  <MetaRow label="From Node" value={feature.from_node} />
                  <MetaRow label="To Node" value={feature.to_node} />
                </div>
              </Section>
            )}
          </>
        ) : null}

        {/* Model Results */}
        {results && Object.keys(results.series).length > 0 ? (
          <Section title="Model Results">
            <ResultsChart
              series={results.series}
              metadata={results.metadata}
              dateRange={dateRange}
            />
          </Section>
        ) : resultsLoading ? (
          <Section title="Model Results">
            <p className="text-gray-500 text-sm">Loading results…</p>
          </Section>
        ) : results && Object.keys(results.series).length === 0 ? (
          <Section title="Model Results">
            <p className="text-gray-500 text-sm italic">No result data for this node.</p>
          </Section>
        ) : null}
      </div>

      {/* Fixed year range slider at panel bottom */}
      <YearRangeSlider
        years={years}
        startIdx={startIdx}
        endIdx={endIdx}
        onStartChange={setStartIdx}
        onEndChange={setEndIdx}
      />
    </div>
  );
}
