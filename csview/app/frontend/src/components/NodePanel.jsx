import { useState, useEffect, useRef, useMemo } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import {
  ComposedChart,
  Bar,
  Line,
  LineChart,
  BarChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { fetchFeature, fetchFeatureResults, fetchGwBudget } from "../api/client.js";
import {
  buildChartData,
  aggregateMonthlyAvg,
  aggregateWaterYear,
  computeYearTicks,
  cfsToTaf,
} from "./charts/chartUtils.js";
import { ChartTooltip } from "./charts/ChartParts.jsx";
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

// Shared aggregation modes — used by the GW budget panel, normal feature view, and comparison mode.
const AGG_MODES = [
  { key: "raw",     label: "Time Series" },
  { key: "monthly", label: "Monthly Avg" },
  { key: "annual",  label: "Water Year"  },
];

// ---------------------------------------------------------------------------
// Comparison mode constants
// ---------------------------------------------------------------------------

const COMP_STUDY_COLORS = [
  "#3b82f6", // blue
  "#f59e0b", // amber
  "#ef4444", // red
  "#10b981", // green
  "#8b5cf6", // purple
  "#06b6d4", // cyan
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
// Cumulative storage comparison chart — one line per study, running sum of
// negated CHANGE_STORAGE (same sign convention as single-study _addCumStorage)
// ---------------------------------------------------------------------------

function CumStorageComparisonChart({ studySeriesMap, studyNames, dateRange, aggMode }) {
  const rawData = useMemo(
    () => buildChartData(studySeriesMap, dateRange, null, null, null),
    [studySeriesMap, dateRange] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const data = useMemo(() => {
    if (rawData.length === 0) return [];
    // Optionally aggregate water-year sums before running cumulation
    const rows = aggMode === "annual" ? aggregateWaterYear(rawData, studyNames) : rawData;
    const cumSums = {};
    for (const name of studyNames) cumSums[name] = 0;
    return rows.map((row) => {
      const out = { date: row.date };
      for (const name of studyNames) {
        cumSums[name] += -(row[name] ?? 0);
        out[name] = cumSums[name];
      }
      return out;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawData, studyNames, aggMode]);

  const isAgg = aggMode !== "raw";

  const yearTicks = useMemo(
    () => aggMode === "raw" ? computeYearTicks(data) : undefined,
    [data, aggMode] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const yDomain = useMemo(() => {
    const vals = data.flatMap((row) =>
      studyNames.map((k) => row[k]).filter((v) => v != null && !isNaN(v))
    );
    if (vals.length === 0) return ["auto", "auto"];
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const pad = (mx - mn) * 0.05 || Math.abs(mx) * 0.05 || 1;
    return [mn - pad, mx + pad];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, studyNames]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
        No data in the selected range.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
        <XAxis
          dataKey="date"
          ticks={yearTicks}
          tick={{ fontSize: 10, fill: "#6b7280" }}
          tickFormatter={isAgg ? undefined : (v) => v.slice(0, 4)}
          interval={
            !isAgg ? undefined
            : aggMode === "monthly" ? 0
            : Math.max(0, Math.ceil(data.length / 8) - 1)
          }
        />
        <YAxis
          domain={yDomain}
          tick={{ fontSize: 10, fill: "#6b7280" }}
          tickFormatter={(v) =>
            Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)
          }
          label={{
            value: "AF",
            angle: -90,
            position: "insideLeft",
            style: { fontSize: 10, fill: "#6b7280" },
          }}
        />
        <Tooltip content={<ChartTooltip yUnit="AF" />} />
        <ReferenceLine y={0} stroke="#4b5563" strokeWidth={1} />
        {studyNames.map((name, i) => (
          <Line
            key={name}
            type="monotone"
            dataKey={name}
            stroke={COMP_STUDY_COLORS[i % COMP_STUDY_COLORS.length]}
            dot={isAgg ? { r: 2 } : false}
            strokeWidth={2}
            connectNulls
            activeDot={{ r: 3 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
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
// Comparison chart — one line/bar per study for a single selected variable
// ---------------------------------------------------------------------------

function ComparisonChart({ studySeriesMap, studyNames, dateRange, aggMode, displayUnit, rawUnits }) {
  const isCFS = (rawUnits || "").toUpperCase() === "CFS";
  const convertFn = displayUnit === "TAF" && isCFS ? cfsToTaf : null;
  const cfsKeySet = isCFS ? new Set(studyNames) : null;
  const annualAvgKeys = convertFn ? null : cfsKeySet;

  const rawData = useMemo(
    () => buildChartData(studySeriesMap, dateRange, null, convertFn, cfsKeySet),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [studySeriesMap, dateRange, displayUnit, rawUnits]
  );

  const data = useMemo(() => {
    if (aggMode === "monthly") return aggregateMonthlyAvg(rawData, studyNames);
    if (aggMode === "annual")  return aggregateWaterYear(rawData, studyNames, annualAvgKeys);
    return rawData;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawData, studyNames, aggMode]);

  const yUnit = convertFn ? "TAF" : (rawUnits || "");
  const isAgg = aggMode !== "raw";

  const yearTicks = useMemo(
    () => aggMode === "raw" ? computeYearTicks(data) : undefined,
    [data, aggMode] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const yDomain = useMemo(() => {
    const vals = data.flatMap((row) =>
      studyNames.map((k) => row[k]).filter((v) => v != null && !isNaN(v))
    );
    if (vals.length === 0) return ["auto", "auto"];
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const pad = (mx - mn) * 0.05 || Math.abs(mx) * 0.05 || 1;
    return [mn - pad, mx + pad];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, studyNames]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
        No data in the selected range.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
        <XAxis
          dataKey="date"
          ticks={yearTicks}
          tick={{ fontSize: 10, fill: "#6b7280" }}
          tickFormatter={isAgg ? undefined : (v) => v.slice(0, 4)}
          interval={
            !isAgg ? undefined
            : aggMode === "monthly" ? 0
            : Math.max(0, Math.ceil(data.length / 8) - 1)
          }
        />
        <YAxis
          domain={yDomain}
          tick={{ fontSize: 10, fill: "#6b7280" }}
          tickFormatter={(v) =>
            Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)
          }
          label={{
            value: yUnit,
            angle: -90,
            position: "insideLeft",
            style: { fontSize: 10, fill: "#6b7280" },
          }}
        />
        <Tooltip content={<ChartTooltip yUnit={yUnit} />} />
        <ReferenceLine y={0} stroke="#4b5563" strokeWidth={1} />
        {aggMode === "raw" &&
          data.filter((r) => r.date.slice(5, 7) === "09").map((r) => (
            <ReferenceLine
              key={`oct-${r.date}`}
              x={r.date}
              stroke="#374151"
              strokeWidth={0.5}
              opacity={0.7}
            />
          ))}
        {studyNames.map((name, i) => (
          <Line
            key={name}
            type="monotone"
            dataKey={name}
            stroke={COMP_STUDY_COLORS[i % COMP_STUDY_COLORS.length]}
            dot={isAgg ? { r: 2 } : false}
            strokeWidth={2}
            connectNulls
            activeDot={{ r: 3 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function NodePanel({ featureId, wbaId, activeStudy, comparisonMode = false, allStudies = [], onClose }) {
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

  // --- Comparison mode state ---
  const [compEnabled, setCompEnabled] = useState(() => new Set(allStudies.map((s) => s.name)));
  const [compVariable, setCompVariable] = useState(null);
  const [compGwComponent, setCompGwComponent] = useState(null);

  // Sync compEnabled when the studies list changes (e.g. different studies loaded)
  useEffect(() => {
    setCompEnabled(new Set(allStudies.map((s) => s.name)));
  }, [allStudies.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset selected variable when the selected feature changes
  useEffect(() => {
    setCompVariable(null);
  }, [featureId]);

  // Reset selected GW component when the selected WBA changes
  useEffect(() => {
    setCompGwComponent(null);
  }, [wbaId]);

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

  // Fetch results for all studies in parallel (used by comparison mode)
  const allStudyResults = useQueries({
    queries: allStudies.map((s) => ({
      queryKey: ["featureResults", featureId, s.name],
      queryFn: () => fetchFeatureResults(featureId, s.name),
      enabled: comparisonMode && !!featureId,
      retry: false,
    })),
  });

  // Fetch GW budget for all studies in parallel (used by comparison mode for WBAs)
  const allGwStudyResults = useQueries({
    queries: allStudies.map((s) => ({
      queryKey: ["gwBudget", wbaId, s.name],
      queryFn: () => fetchGwBudget(wbaId, s.name),
      enabled: comparisonMode && !!wbaId,
      retry: false,
    })),
  });

  // ---------------------------------------------------------------------------
  // Comparison-mode derived data (always computed so hooks are unconditional)
  // ---------------------------------------------------------------------------

  const compAllVarKeys = useMemo(() => {
    const keys = new Set();
    for (const r of allStudyResults) {
      if (r.data?.series) Object.keys(r.data.series).forEach((k) => keys.add(k));
    }
    return Array.from(keys).sort();
  }, [allStudyResults]); // eslint-disable-line react-hooks/exhaustive-deps

  const compEffectiveVar =
    compVariable && compAllVarKeys.includes(compVariable)
      ? compVariable
      : compAllVarKeys[0] ?? null;

  const compSeriesMap = useMemo(() => {
    if (!compEffectiveVar) return {};
    const out = {};
    for (let i = 0; i < allStudies.length; i++) {
      const s = allStudies[i];
      if (!compEnabled.has(s.name)) continue;
      const r = allStudyResults[i];
      if (!r?.data?.series) continue;
      const varData = r.data.series[compEffectiveVar];
      if (varData) out[s.name] = varData;
    }
    return out;
  }, [allStudyResults, allStudies, compEnabled, compEffectiveVar]); // eslint-disable-line react-hooks/exhaustive-deps

  const compVarMeta = useMemo(() => {
    for (const r of allStudyResults) {
      if (r.data?.metadata?.[compEffectiveVar]) return r.data.metadata[compEffectiveVar];
    }
    return null;
  }, [allStudyResults, compEffectiveVar]); // eslint-disable-line react-hooks/exhaustive-deps

  const compRawUnits = compVarMeta?.units || "CFS";
  const compVarDescription = compVarMeta?.description || "";
  const compHasCFS = compRawUnits.toUpperCase() === "CFS";

  const compStudyNames = useMemo(
    () =>
      allStudies
        .filter((s) => compEnabled.has(s.name) && compSeriesMap[s.name])
        .map((s) => s.name),
    [allStudies, compEnabled, compSeriesMap] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const compLoading = allStudyResults.some((r) => r.isLoading);

  // ---------------------------------------------------------------------------
  // GW comparison-mode derived data
  // ---------------------------------------------------------------------------

  const compGwAllComponents = useMemo(() => {
    const keys = new Set();
    for (const r of allGwStudyResults) {
      if (r.data?.series) Object.keys(r.data.series).forEach((k) => keys.add(k));
    }
    return Array.from(keys).sort();
  }, [allGwStudyResults]); // eslint-disable-line react-hooks/exhaustive-deps

  const compGwCPartLabels = useMemo(() => {
    for (const r of allGwStudyResults) {
      if (r.data?.c_part_labels) return r.data.c_part_labels;
    }
    return {};
  }, [allGwStudyResults]); // eslint-disable-line react-hooks/exhaustive-deps

  const compGwEffectiveComponent =
    compGwComponent && compGwAllComponents.includes(compGwComponent)
      ? compGwComponent
      : compGwAllComponents[0] ?? null;

  const compGwSeriesMap = useMemo(() => {
    if (!compGwEffectiveComponent) return {};
    const out = {};
    for (let i = 0; i < allStudies.length; i++) {
      const s = allStudies[i];
      if (!compEnabled.has(s.name)) continue;
      const r = allGwStudyResults[i];
      if (!r?.data?.series) continue;
      const varData = r.data.series[compGwEffectiveComponent];
      if (varData) out[s.name] = varData;
    }
    return out;
  }, [allGwStudyResults, allStudies, compEnabled, compGwEffectiveComponent]); // eslint-disable-line react-hooks/exhaustive-deps

  const compGwStudyNames = useMemo(
    () => allStudies.filter((s) => compEnabled.has(s.name) && compGwSeriesMap[s.name]).map((s) => s.name),
    [allStudies, compEnabled, compGwSeriesMap] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const compGwLoading = allGwStudyResults.some((r) => r.isLoading);

  // CHANGE_STORAGE series for each enabled study — used for cumulative storage chart
  const compGwCumStorageSeriesMap = useMemo(() => {
    const out = {};
    for (let i = 0; i < allStudies.length; i++) {
      const s = allStudies[i];
      if (!compEnabled.has(s.name)) continue;
      const series = allGwStudyResults[i]?.data?.series;
      if (series?.CHANGE_STORAGE) out[s.name] = series.CHANGE_STORAGE;
    }
    return out;
  }, [allGwStudyResults, allStudies, compEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const compGwCumStorageStudyNames = useMemo(
    () => allStudies.filter((s) => compEnabled.has(s.name) && !!compGwCumStorageSeriesMap[s.name]).map((s) => s.name),
    [allStudies, compEnabled, compGwCumStorageSeriesMap] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const compGwHasCumStorage =
    compGwEffectiveComponent === "CHANGE_STORAGE" &&
    compGwCumStorageStudyNames.length > 0 &&
    gwAggMode !== "monthly";

  // Pre-build variable → description map so the <select> render avoids 
  // scanning allStudyResults on every paint.
  const compVarDescriptions = useMemo(() => {
    const map = {};
    for (const r of allStudyResults) {
      if (!r.data?.metadata) continue;
      for (const [k, meta] of Object.entries(r.data.metadata)) {
        if (!map[k] && meta?.description) map[k] = meta.description;
      }
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allStudyResults]);

  // Derive sorted unique water years from any result series
  const years = useMemo(() => {
    // In comparison mode, fall back to first loaded comparison result when
    // the active-study results are absent or empty.
    const activeSeries =
      results?.series && Object.keys(results.series).length > 0 ? results.series : null;
    const compFallback = comparisonMode
      ? (allStudyResults.find(
          (r) => r.data?.series && Object.keys(r.data.series).length > 0
        )?.data?.series ?? null)
      : null;
    const src = activeSeries ?? compFallback;
    if (!src) return [];
    const firstKey = Object.keys(src)[0];
    if (!firstKey) return [];
    const wySet = new Set(
      src[firstKey]
        .map((row) => {
          const d = String(row[0]);
          const y = Number(d.slice(0, 4));
          const m = Number(d.slice(5, 7));
          return String(m >= 10 ? y + 1 : y);
        })
        .filter((y) => /^\d{4}$/.test(y))
    );
    return Array.from(wySet).sort();
  }, [results, comparisonMode, allStudyResults]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // Render: GW budget comparison (WBA selected + comparison mode on)
  // ---------------------------------------------------------------------------
  if (comparisonMode && wbaId) {
    const gwDateRange = gwStartYear && gwEndYear ? [String(gwStartYear), String(gwEndYear)] : null;
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 shrink-0">
          <div className="min-w-0">
            <h2 className="font-mono text-blue-400 font-semibold truncate">WBA {wbaId}</h2>
            <p className="text-[10px] text-orange-400 font-semibold uppercase tracking-wide">
              Comparison Mode
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 text-xl leading-none ml-2 shrink-0"
            aria-label="Close panel"
          >
            ×
          </button>
        </div>

        {/* Controls */}
        <div className="px-4 py-2 border-b border-gray-700 shrink-0 space-y-2">
          {/* Component dropdown */}
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-gray-500 shrink-0">Component:</label>
            <select
              value={compGwEffectiveComponent || ""}
              onChange={(e) => setCompGwComponent(e.target.value)}
              className="flex-1 text-xs bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-gray-200 focus:outline-none focus:border-blue-500 min-w-0"
            >
              {compGwAllComponents.map((k) => (
                <option key={k} value={k}>
                  {compGwCPartLabels[k] || k}
                </option>
              ))}
            </select>
          </div>

          {/* Study toggle pills */}
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-[10px] text-gray-500 shrink-0">Studies:</span>
            {allStudies.map((s, i) => {
              const enabled = compEnabled.has(s.name);
              const color = COMP_STUDY_COLORS[i % COMP_STUDY_COLORS.length];
              return (
                <button
                  key={s.name}
                  onClick={() =>
                    setCompEnabled((prev) => {
                      const n = new Set(prev);
                      n.has(s.name) ? n.delete(s.name) : n.add(s.name);
                      return n;
                    })
                  }
                  className={`text-[10px] px-2.5 py-0.5 rounded border font-medium transition-all ${
                    enabled ? "opacity-100" : "opacity-30 border-gray-600 text-gray-500"
                  }`}
                  style={enabled ? { borderColor: color, color } : {}}
                >
                  {s.name}
                </button>
              );
            })}
          </div>

          {/* Aggregation view mode — no units toggle (GW is always AF) */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-gray-500 mr-1">View:</span>
            {AGG_MODES.map((m) => (
              <button
                key={m.key}
                onClick={() => setGwAggMode(m.key)}
                className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                  gwAggMode === m.key
                    ? "border-blue-500 text-blue-400 bg-blue-950"
                    : "border-gray-600 text-gray-400 hover:border-blue-400 hover:text-blue-400"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Chart area */}
        <div className="flex-1 overflow-y-auto py-3 px-2 min-h-0">
          {compGwLoading && (
            <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
              Loading study data…
            </div>
          )}
          {!compGwLoading && !compGwEffectiveComponent && (
            <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
              No GW budget data for this WBA.
            </div>
          )}
          {!compGwLoading && compGwEffectiveComponent && (
            <>
              {/* Study color legend */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 px-2 mb-3">
                {allStudies.map((s, i) => {
                  const enabled = compEnabled.has(s.name) && !!compGwSeriesMap[s.name];
                  const color = COMP_STUDY_COLORS[i % COMP_STUDY_COLORS.length];
                  return (
                    <div
                      key={s.name}
                      className={`flex items-center gap-1.5 text-[10px] transition-opacity ${
                        enabled ? "opacity-100" : "opacity-25"
                      }`}
                    >
                      <span
                        className="inline-block w-5 rounded-sm"
                        style={{ height: 2, background: color, borderRadius: 1 }}
                      />
                      <span className="text-gray-300">{s.name}</span>
                    </div>
                  );
                })}
              </div>

              {/* Component comparison chart */}
              {compGwStudyNames.length === 0 ? (
                <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
                  No studies selected.
                </div>
              ) : (
                <ComparisonChart
                  studySeriesMap={compGwSeriesMap}
                  studyNames={compGwStudyNames}
                  dateRange={gwDateRange}
                  aggMode={gwAggMode}
                  displayUnit="AF"
                  rawUnits={gwUnits}
                />
              )}

              {/* Cumulative ΔStorage comparison */}
              {compGwHasCumStorage && (
                <>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-500 px-2 mt-4 mb-1">
                    Cumulative ΔStorage
                  </p>
                  <CumStorageComparisonChart
                    studySeriesMap={compGwCumStorageSeriesMap}
                    studyNames={compGwCumStorageStudyNames}
                    dateRange={gwDateRange}
                    aggMode={gwAggMode}
                  />
                </>
              )}
            </>
          )}
        </div>

        {/* GW year range slider */}
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
          {AGG_MODES.map((m) => (
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
  // Render: comparison mode (featureId selected + comparison mode on)
  // ---------------------------------------------------------------------------
  if (comparisonMode && featureId) {
    return (
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 shrink-0">
          <div className="min-w-0">
            <h2 className="font-mono text-blue-400 font-semibold truncate">{featureId}</h2>
            <p className="text-[10px] text-orange-400 font-semibold uppercase tracking-wide">
              Comparison Mode
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-200 text-xl leading-none ml-2 shrink-0"
            aria-label="Close panel"
          >
            ×
          </button>
        </div>

        {/* Controls */}
        <div className="px-4 py-2 border-b border-gray-700 shrink-0 space-y-2">
          {/* Variable dropdown */}
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-gray-500 shrink-0">Variable:</label>
            <select
              value={compEffectiveVar || ""}
              onChange={(e) => setCompVariable(e.target.value)}
              className="flex-1 text-xs bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-gray-200 focus:outline-none focus:border-blue-500 min-w-0"
            >
              {compAllVarKeys.map((k) => (
                <option key={k} value={k}>
                  {k}{compVarDescriptions[k] ? ` \u2014 ${compVarDescriptions[k]}` : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Study toggle pills */}
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-[10px] text-gray-500 shrink-0">Studies:</span>
            {allStudies.map((s, i) => {
              const enabled = compEnabled.has(s.name);
              const color = COMP_STUDY_COLORS[i % COMP_STUDY_COLORS.length];
              return (
                <button
                  key={s.name}
                  onClick={() =>
                    setCompEnabled((prev) => {
                      const n = new Set(prev);
                      n.has(s.name) ? n.delete(s.name) : n.add(s.name);
                      return n;
                    })
                  }
                  className={`text-[10px] px-2.5 py-0.5 rounded border font-medium transition-all ${
                    enabled ? "opacity-100" : "opacity-30 border-gray-600 text-gray-500"
                  }`}
                  style={enabled ? { borderColor: color, color } : {}}
                >
                  {s.name}
                </button>
              );
            })}
          </div>

          {/* Units + view mode */}
          <div className="flex items-center gap-3 flex-wrap">
            {compHasCFS && (
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-gray-500 mr-1">Units:</span>
                {["CFS", "TAF"].map((u) => (
                  <button
                    key={u}
                    onClick={() => setDisplayUnit(u)}
                    className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                      displayUnit === u
                        ? "border-blue-500 text-blue-400 bg-blue-950"
                        : "border-gray-600 text-gray-400 hover:border-blue-400 hover:text-blue-400"
                    }`}
                  >
                    {u}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-500 mr-1">View:</span>
              {AGG_MODES.map((m) => (
                <button
                  key={m.key}
                  onClick={() => setAggMode(m.key)}
                  className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                    aggMode === m.key
                      ? "border-blue-500 text-blue-400 bg-blue-950"
                      : "border-gray-600 text-gray-400 hover:border-blue-400 hover:text-blue-400"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Chart area */}
        <div className="flex-1 overflow-y-auto py-3 px-2 min-h-0">
          {compLoading && (
            <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
              Loading study data…
            </div>
          )}
          {!compLoading && !compEffectiveVar && (
            <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
              No data for this feature.
            </div>
          )}
          {!compLoading && compEffectiveVar && (
            <>
              {/* Study color legend */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 px-2 mb-3">
                {allStudies.map((s, i) => {
                  const enabled = compEnabled.has(s.name) && !!compSeriesMap[s.name];
                  const color = COMP_STUDY_COLORS[i % COMP_STUDY_COLORS.length];
                  return (
                    <div
                      key={s.name}
                      className={`flex items-center gap-1.5 text-[10px] transition-opacity ${
                        enabled ? "opacity-100" : "opacity-25"
                      }`}
                    >
                      <span
                        className="inline-block w-5 rounded-sm"
                        style={{
                          height: 2,
                          background: color,
                          borderRadius: 1,
                        }}
                      />
                      <span className="text-gray-300">{s.name}</span>
                    </div>
                  );
                })}
              </div>
              {compVarDescription && (
                <p className="text-[10px] text-gray-500 px-2 mb-2 italic">
                  {compVarDescription}
                </p>
              )}
              {compStudyNames.length === 0 ? (
                <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
                  No studies selected.
                </div>
              ) : (
                <ComparisonChart
                  studySeriesMap={compSeriesMap}
                  studyNames={compStudyNames}
                  dateRange={dateRange}
                  aggMode={aggMode}
                  displayUnit={displayUnit}
                  rawUnits={compRawUnits}
                />
              )}
            </>
          )}
        </div>

        {/* Year range slider */}
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
