import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchFeature, fetchFeatureResults } from "../api/client.js";
import ResultsChart from "./ResultsChart.jsx";
import YearRangeSlider from "./YearRangeSlider.jsx";

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
        <span className="text-gray-600">{open ? "\u25BE" : "\u25B8"}</span>
        {title}
      </button>
      {open && <div className="px-4">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function NodePanel({ featureId, activeStudy, onClose }) {
  const [startIdx, setStartIdx] = useState(0);
  const [endIdx, setEndIdx] = useState(0);
  const [displayUnit, setDisplayUnit] = useState("CFS");
  const [aggMode, setAggMode] = useState("raw");
  const sliderInitialized = useRef(false);

  const { data: feature, isLoading: nodeLoading } = useQuery({
    queryKey: ["feature", featureId],
    queryFn: () => fetchFeature(featureId),
    enabled: !!featureId,
  });

  const { data: results, isLoading: resultsLoading, isError: resultsError } = useQuery({
    queryKey: ["featureResults", featureId, activeStudy],
    queryFn: () => fetchFeatureResults(featureId, activeStudy),
    enabled: !!featureId,
    retry: false,
  });

  // Derive sorted unique water years from any result series
  const years = useMemo(() => {
    if (!results?.series) return [];
    const firstKey = Object.keys(results.series)[0];
    if (!firstKey) return [];
    const wySet = new Set(
      results.series[firstKey]
        .map((row) => {
          const d = String(row[0]);
          const y = Number(d.slice(0, 4));
          const m = Number(d.slice(5, 7));
          return String(m >= 10 ? y + 1 : y);
        })
        .filter((y) => /^\d{4}$/.test(y))
    );
    return Array.from(wySet).sort();
  }, [results]);

  // On first-ever data load, set full range.  On subsequent feature changes,
  // clamp existing indices to the (usually identical) new years array.
  useEffect(() => {
    if (years.length === 0) return;
    if (!sliderInitialized.current) {
      setStartIdx(0);
      setEndIdx(years.length - 1);
      sliderInitialized.current = true;
    } else {
      setStartIdx((prev) => Math.min(prev, years.length - 1));
      setEndIdx((prev) => Math.min(prev, years.length - 1));
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
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-200 text-xl leading-none ml-2 shrink-0"
          aria-label="Close panel"
        >
          ×
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto py-3">
        {nodeLoading ? (
          <p className="px-4 text-gray-500 text-sm">Loading…</p>
        ) : feature ? (
          <>
            {/* ---- Consolidated Information section ---- */}
            <Section title="Information">
              <div className="space-y-1">
                {/* Common properties */}
                <MetaRow label="Description" value={feature.description} />
                <MetaRow label="Feature Kind" value={feature.feature_kind} />
                <MetaRow label="Type" value={feature.node_type || feature.arc_type} />
                <MetaRow label="Units" value={feature.units} />
                <MetaRow label="Hydro Region" value={feature.hydro_region} />

                {/* Solver badge — shown for both arcs and nodes */}
                <div className="flex gap-2 text-sm">
                  <span className="text-gray-400 shrink-0 w-36">Solver</span>
                  {feature.solver_active === false ? (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-600">
                      schematic only
                    </span>
                  ) : (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-green-950 text-green-400 border border-green-800">
                      solver active
                    </span>
                  )}
                </div>

                {/* Arc-specific details */}
                {feature.feature_kind === "arc" && (
                  <>
                    <MetaRow label="Name" value={feature.name} />
                    <MetaRow label="Sub-Type" value={feature.sub_type} />
                    <MetaRow label="From Node" value={feature.from_node} />
                    <MetaRow label="To Node" value={feature.to_node} />
                    {feature.capacity_cfs != null && (
                      <MetaRow
                        label="Capacity"
                        value={`${feature.capacity_cfs.toLocaleString()} CFS`}
                      />
                    )}
                  </>
                )}

                {/* Node geographic / hydrologic metadata (inline, no separate section) */}
                {feature.feature_kind === "node" && (
                  <>
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
                  </>
                )}
              </div>

              {/* WRESL suggestion — toned-down note style */}
              {feature.feature_kind === "arc" && feature.wresl_suggestion && (
                <div className="mt-3 flex items-center gap-2 text-xs text-gray-400">
                  <span className="text-gray-500">ℹ</span>
                  <span>
                    Suggested WRESL match:{" "}
                    <span className="font-mono text-gray-300 px-1 py-0.5 rounded bg-gray-800 border border-gray-700">
                      {feature.wresl_suggestion}
                    </span>
                  </span>
                </div>
              )}
            </Section>

            {/* Missing WRESL arcs — arcs in solver equations but absent from schematic */}
            {feature.feature_kind === "node" && feature.missing_arcs?.length > 0 && (
              <Section title="Solver-Only Arcs" defaultOpen={false}>
                <p className="text-xs text-gray-500 mb-2">
                  Arc variables referencing this node in WRESL but absent from the GeoSchematic.
                </p>
                <div className="flex flex-wrap gap-1">
                  {feature.missing_arcs.map((a) => (
                    <span
                      key={a}
                      className="font-mono text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700"
                    >
                      {a}
                    </span>
                  ))}
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
              displayUnit={displayUnit}
              onDisplayUnitChange={setDisplayUnit}
              aggMode={aggMode}
              onAggModeChange={setAggMode}
            />
          </Section>
        ) : resultsLoading ? (
          <Section title="Model Results">
            <p className="text-gray-500 text-sm">Loading results…</p>
          </Section>
        ) : resultsError && feature?.wresl_suggestion ? (
          <Section title="Model Results">
            <div className="px-3 py-1.5 rounded border border-gray-600 text-xs text-gray-400">
              <p>No DSS output for this arc or its suggested match{" "}
                <span className="font-mono text-gray-300 px-1 py-0.5 rounded bg-gray-800 border border-gray-700">
                  {feature.wresl_suggestion}
                </span>.
              </p>
            </div>
          </Section>
        ) : resultsError ? (
          <Section title="Model Results">
            <p className="text-gray-500 text-sm italic">No result data for this feature.</p>
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
