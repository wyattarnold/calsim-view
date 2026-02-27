import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { fetchFeature, fetchFeatureResults, fetchGwBudget } from "../api/client.js";
import ResultsChart from "./ResultsChart.jsx";
import YearRangeSlider from "./YearRangeSlider.jsx";

// ---------------------------------------------------------------------------
// GW Budget constants + helpers (used when wbaId is provided)
// ---------------------------------------------------------------------------

const GW_COMPONENT_COLORS = {
  PUMPING:         "#ef4444",
  NET_DEEP_PERC:   "#3b82f6",
  STRM_GW_INT:     "#06b6d4",
  LATERAL_FLOW:    "#8b5cf6",
  CHANGE_STORAGE:  "#f59e0b",
  SMALL_WSHED:     "#10b981",
  SUBSIDENCE:      "#f97316",
  TILE_DRAIN:      "#ec4899",
  FLOW_BC:         "#84cc16",
  HEAD_BC:         "#14b8a6",
  GHB:             "#a78bfa",
};
const GW_DEFAULT_COLOR = "#6b7280";

const GW_AGG_MODES = [
  { key: "raw",     label: "Time Series"   },
  { key: "monthly", label: "Monthly Avg"  },
  { key: "annual",  label: "Water Year"   },
];

function _waterYear(dateStr) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  return m >= 10 ? y + 1 : y;
}

function _buildGwChartData(series) {
  const dateMap = {};
  for (const key of Object.keys(series)) {
    for (const [date, val] of series[key]) {
      if (!dateMap[date]) dateMap[date] = { date };
      dateMap[date][key] = val;
    }
  }
  return Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
}

function _aggregateGwAnnual(data, keys) {
  const wyMap = {};
  for (const row of data) {
    const wy = _waterYear(row.date);
    if (!wyMap[wy]) {
      wyMap[wy] = { date: `WY${wy}` };
      for (const k of keys) wyMap[wy][k] = 0;
    }
    for (const k of keys) { if (row[k] != null) wyMap[wy][k] += row[k]; }
  }
  return Object.values(wyMap).sort((a, b) => a.date.localeCompare(b.date));
}

const WY_MONTH_ORDER = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function _aggregateGwMonthly(data, keys) {
  const acc = {};
  for (const m of WY_MONTH_ORDER) acc[m] = { date: MONTH_LABELS[m - 1], _n: 0 };
  for (const row of data) {
    const m = Number(row.date.slice(5, 7));
    acc[m]._n++;
    for (const k of keys) acc[m][k] = (acc[m][k] || 0) + (row[k] ?? 0);
  }
  return WY_MONTH_ORDER.map((m) => {
    const n = acc[m]._n || 1;
    const out = { date: acc[m].date };
    for (const k of keys) out[k] = acc[m][k] / n;
    return out;
  });
}

// Cumulative storage: negate CHANGE_STORAGE running sum.
// Negative CHANGE_STORAGE → storage rising; positive → storage falling.
function _addCumStorage(data, keys) {
  if (!keys.includes("CHANGE_STORAGE")) return data;
  let cum = 0;
  return data.map((row) => {
    cum += -(row["CHANGE_STORAGE"] ?? 0);
    return { ...row, _cumStorage: cum };
  });
}

function GwBudgetTooltip({ active, payload, label, cPartLabels, units }) {
  if (!active || !payload?.length) return null;
  const barPayload = payload.filter((p) => p.dataKey !== "_cumStorage" && p.value !== 0);
  const cumEntry  = payload.find((p) => p.dataKey === "_cumStorage");
  return (
    <div className="bg-gray-900/95 border border-gray-600 rounded px-3 py-2 text-xs max-w-xs">
      <p className="font-semibold text-gray-300 mb-1">{label}</p>
      {barPayload
        .map((p) => (
          <div key={p.dataKey} className="flex justify-between gap-3">
            <span style={{ color: p.fill }}>{cPartLabels[p.dataKey] || p.dataKey}</span>
            <span className="text-gray-200 font-mono">
              {p.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          </div>
        ))}
      <div className="mt-1 pt-1 border-t border-gray-700 flex justify-between gap-3">
        <span className="text-gray-400">Net flux</span>
        <span className="text-gray-200 font-mono font-semibold">
          {barPayload.reduce((s, p) => s + (p.value || 0), 0)
            .toLocaleString(undefined, { maximumFractionDigits: 0 })}{" "}
          <span className="text-gray-500 font-normal">{units}</span>
        </span>
      </div>
      {cumEntry != null && (
        <div className="mt-1 flex justify-between gap-3 text-amber-400">
          <span>Cum. ΔStorage</span>
          <span className="font-mono font-semibold">
            {cumEntry.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}{" "}
            <span className="text-gray-500 font-normal">{units}</span>
          </span>
        </div>
      )}
    </div>
  );
}

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

export default function NodePanel({ featureId, wbaId, activeStudy, onClose }) {
  // --- network feature state ---
  const [startIdx, setStartIdx] = useState(0);
  const [endIdx, setEndIdx] = useState(0);
  const [displayUnit, setDisplayUnit] = useState("CFS");
  const [aggMode, setAggMode] = useState("raw");
  const sliderInitialized = useRef(false);

  // --- GW budget state ---
  const [gwAggMode, setGwAggMode] = useState("annual");
  const [gwHidden, setGwHidden] = useState(new Set());
  const [gwStartIdx, setGwStartIdx] = useState(0);
  const [gwEndIdx, setGwEndIdx] = useState(0);
  const gwSliderInit = useRef(false);

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

  const { data: gwData, isLoading: gwLoading, isError: gwError, error: gwErrorObj } = useQuery({
    queryKey: ["gwBudget", wbaId, activeStudy],
    queryFn: () => fetchGwBudget(wbaId, activeStudy),
    enabled: !!wbaId,
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

  // --- GW budget derived data ---
  const gwCPartLabels = gwData?.c_part_labels || {};
  const gwUnits = gwData?.units || "AF";
  const gwKeys = useMemo(() => Object.keys(gwData?.series || {}), [gwData]);
  const gwRawData = useMemo(
    () => (gwData?.series ? _buildGwChartData(gwData.series) : []),
    [gwData]
  );

  const gwYears = useMemo(() => {
    if (!gwRawData.length) return [];
    const s = new Set(gwRawData.map((r) => String(_waterYear(r.date))));
    return Array.from(s).sort();
  }, [gwRawData]);

  useEffect(() => {
    if (gwYears.length === 0) return;
    if (!gwSliderInit.current) {
      setGwStartIdx(0);
      setGwEndIdx(gwYears.length - 1);
      gwSliderInit.current = true;
    } else {
      setGwStartIdx((p) => Math.min(p, gwYears.length - 1));
      setGwEndIdx((p) => Math.min(p, gwYears.length - 1));
    }
  }, [gwYears.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const gwStartYear = gwYears.length ? Number(gwYears[Math.min(gwStartIdx, gwYears.length - 1)]) : null;
  const gwEndYear   = gwYears.length ? Number(gwYears[Math.min(gwEndIdx,   gwYears.length - 1)]) : null;

  const gwFilteredData = useMemo(() => {
    if (!gwStartYear || !gwEndYear) return gwRawData;
    return gwRawData.filter((r) => {
      const wy = _waterYear(r.date);
      return wy >= gwStartYear && wy <= gwEndYear;
    });
  }, [gwRawData, gwStartYear, gwEndYear]);

  const gwChartData = useMemo(() => {
    if (gwAggMode === "annual")  return _addCumStorage(_aggregateGwAnnual(gwFilteredData, gwKeys), gwKeys);
    if (gwAggMode === "monthly") return _aggregateGwMonthly(gwFilteredData, gwKeys); // no cum line in avg mode
    return _addCumStorage(gwFilteredData, gwKeys);
  }, [gwFilteredData, gwKeys, gwAggMode]);

  // Keys where at least one row has a non-zero value across the full dataset
  const nonZeroGwKeys = useMemo(
    () => gwKeys.filter((k) => gwRawData.some((r) => r[k] != null && r[k] !== 0)),
    [gwKeys, gwRawData]
  );

  const visibleGwKeys = useMemo(() => nonZeroGwKeys.filter((k) => !gwHidden.has(k)), [nonZeroGwKeys, gwHidden]);
  const toggleGwKey = (key) =>
    setGwHidden((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const showCumStorage = gwAggMode !== "monthly" && gwKeys.includes("CHANGE_STORAGE");

  // ---------------------------------------------------------------------------
  // Render: empty state
  // ---------------------------------------------------------------------------
  if (!featureId && !wbaId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm px-6 text-center">
        <p className="text-2xl mb-3">🗺</p>
        <p>Click a feature on the map to see its details.</p>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: GW budget (WBA selected)
  // ---------------------------------------------------------------------------
  if (wbaId) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 shrink-0">
          <div className="min-w-0">
            <h2 className="font-mono text-blue-400 font-semibold truncate">WBA {wbaId}</h2>
            <p className="text-xs text-gray-400">GW Budget Components ({gwUnits})</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 text-xl leading-none ml-2 shrink-0"
            aria-label="Close panel"
          >×</button>
        </div>

        {/* Aggregation toggle */}
        <div className="px-4 py-1.5 border-b border-gray-700 shrink-0 flex items-center gap-1">
          <span className="text-[10px] text-gray-500 mr-1">View:</span>
          {GW_AGG_MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => setGwAggMode(m.key)}
              className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                gwAggMode === m.key
                  ? "border-blue-500 text-blue-400 bg-blue-950"
                  : "border-gray-600 text-gray-400 hover:border-blue-400 hover:text-blue-400"
              }`}
            >{m.label}</button>
          ))}
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto py-3 min-h-0">
          {gwLoading && (
            <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
              Loading GW budget…
            </div>
          )}
          {gwError && (
            <div className="px-4 py-6 text-center text-gray-500 text-sm">
              <p>No GW budget data for WBA {wbaId}.</p>
              <p className="text-xs text-gray-600 mt-1">{gwErrorObj?.message}</p>
            </div>
          )}
          {gwData && !gwLoading && (
            <div className="px-2 py-1">
              {/* Toggleable legend — components */}
              <div className="flex flex-wrap gap-x-3 gap-y-1 px-2 mb-1">
                {nonZeroGwKeys.map((key) => (
                  <button
                    key={key}
                    onClick={() => toggleGwKey(key)}
                    className={`flex items-center gap-1 text-[10px] transition-opacity ${
                      gwHidden.has(key) ? "opacity-30" : "opacity-100"
                    }`}
                  >
                    <span className="w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ background: GW_COMPONENT_COLORS[key] || GW_DEFAULT_COLOR }} />
                    <span className="text-gray-300">{gwCPartLabels[key] || key}</span>
                  </button>
                ))}
              </div>
              {/* Cum. storage legend item */}
              {showCumStorage && (
                <div className="flex items-center gap-1 px-2 mb-2">
                  <span className="inline-block w-5 border-t-2 border-amber-400" />
                  <span className="text-[10px] text-amber-400">Cum. ΔStorage (right axis)</span>
                </div>
              )}

              {/* Stacked bar + cumulative storage line */}
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart
                  data={gwChartData}
                  margin={{ top: 5, right: showCumStorage ? 50 : 10, left: 5, bottom: 5 }}
                  stackOffset="sign"
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: "#9ca3af" }}
                    tickFormatter={(v) =>
                      gwAggMode === "annual" ? v.replace("WY", "") : v.slice(0, 7)
                    }
                    interval={gwAggMode === "annual" ? 4 : "preserveStartEnd"}
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 10, fill: "#9ca3af" }}
                    tickFormatter={(v) =>
                      Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M`
                        : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}K`
                        : v.toFixed(0)
                    }
                    label={{ value: gwUnits, angle: -90, position: "insideLeft",
                      style: { fontSize: 10, fill: "#6b7280" } }}
                  />
                  {showCumStorage && (
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tick={{ fontSize: 10, fill: "#fbbf24" }}
                      tickFormatter={(v) =>
                        Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M`
                          : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}K`
                          : v.toFixed(0)
                      }
                    />
                  )}
                  <Tooltip content={
                    <GwBudgetTooltip cPartLabels={gwCPartLabels} units={gwUnits} />
                  } />
                  {visibleGwKeys.map((key) => (
                    <Bar key={key} dataKey={key} stackId="a" yAxisId="left"
                      fill={GW_COMPONENT_COLORS[key] || GW_DEFAULT_COLOR}
                      isAnimationActive={false} />
                  ))}
                  {showCumStorage && (
                    <Line
                      yAxisId="right"
                      dataKey="_cumStorage"
                      type="linear"
                      dot={false}
                      strokeWidth={2}
                      stroke="#fbbf24"
                      isAnimationActive={false}
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Year range slider */}
        <YearRangeSlider
          years={gwYears}
          startIdx={gwStartIdx}
          endIdx={gwEndIdx}
          onStartChange={setGwStartIdx}
          onEndChange={setGwEndIdx}
        />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: network feature (featureId selected)
  // ---------------------------------------------------------------------------
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
                <MetaRow label="Name" value={feature.name || feature.river_name} />
                <MetaRow label="Description" value={feature.description} />
                <MetaRow label="Type" value={feature.node_type || feature.arc_type} />
                <MetaRow label="Sub-Type" value={feature.sub_type} />

                {/* Solver badge */}
                <div className="flex gap-2 text-sm flex-wrap">
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
                  {feature.seepage_vars?.length > 0 && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-700">
                      seepage
                    </span>
                  )}
                  {feature.missing_arcs?.length > 0 && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-950 text-yellow-300 border border-yellow-700">
                      solver-only arcs
                    </span>
                  )}
                </div>
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
            {feature.feature_kind === "node" && (feature.missing_arcs?.length > 0 || feature.seepage_vars?.length > 0) && (
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
                  {feature.seepage_vars?.map((a) => (
                    <span
                      key={a}
                      className="font-mono text-xs px-1.5 py-0.5 rounded bg-indigo-950 text-indigo-300 border border-indigo-700"
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
