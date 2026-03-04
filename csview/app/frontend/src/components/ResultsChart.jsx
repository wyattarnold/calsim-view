import { useState, useMemo } from "react";
import {
  ComposedChart,
  LineChart,
  BarChart,
  Bar,
  Line,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

import {
  seriesColor,
  flowSeriesColor,
  REF_COLORS,
  ZONE_COLORS,
  cfsToTaf,
  buildChartData,
  splitSeries,
  aggregateMonthlyAvg,
  aggregateWaterYear,
  aggregateWaterYearEnd,
  computeYearTicks,
  WB_TERMS,
  WB_ORDER,
  WB_COLORS,
  WB_POSITIVE,
} from "./charts/chartUtils.js";
import { ToggleLegend, ChartTooltip } from "./charts/ChartParts.jsx";

// Module-level constant — WB_TERMS keys never change at runtime
const WB_TERMS_SET = new Set(Object.keys(WB_TERMS));

// ---------------------------------------------------------------------------
// Aggregation mode selector — shared by all sub-charts
// ---------------------------------------------------------------------------

const AGG_MODES = [
  { key: "raw",     label: "Time Series" },
  { key: "monthly", label: "Monthly Avg" },
  { key: "annual",  label: "Water Year" },
];

function AggToggle({ mode, onChange }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-gray-500 mr-1">View:</span>
      {AGG_MODES.map((m) => (
        <button key={m.key} onClick={() => onChange(m.key)}
          className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
            mode === m.key
              ? "border-blue-500 text-blue-400 bg-blue-950"
              : "border-gray-600 text-gray-400 hover:border-blue-400 hover:text-blue-400"
          }`}>{m.label}</button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Apply aggregation to a Recharts data array
// ---------------------------------------------------------------------------

function applyAggregation(data, keys, mode, avgKeys = null) {
  if (mode === "monthly") return aggregateMonthlyAvg(data, keys);
  if (mode === "annual")  return aggregateWaterYear(data, keys, avgKeys);
  return data; // "raw"
}

// ---------------------------------------------------------------------------
// Single chart  (plain lines / bars for annual)
// ---------------------------------------------------------------------------

function LineChartPanel({ title, series, metadata = {}, yUnit = "", dateRange, refBounds = [], keyLabels = {}, convertFn = null, aggMode = "raw", isStorage = false, useBarForAnnual = false, zoneSeries = null }) {
  const [hidden, setHidden] = useState(new Set());
  const [collapsed, setCollapsed] = useState(false);
  const keys = Object.keys(series);
  const cfsKeys = useMemo(() => new Set(keys.filter((k) => (metadata?.[k]?.units || "").toUpperCase() === "CFS")), [keys, metadata]); // eslint-disable-line react-hooks/exhaustive-deps
  // When convertFn is null, CFS keys remain as rates → average them at annual scale.
  // When convertFn is set, CFS→TAF has already happened → sum all.
  const annualAvgKeys = convertFn ? null : (cfsKeys.size > 0 ? cfsKeys : null);
  const rawData = buildChartData(series, dateRange, null, convertFn, cfsKeys.size > 0 ? cfsKeys : null);
  const data = useMemo(() => {
    if (aggMode === "monthly") return aggregateMonthlyAvg(rawData, keys);
    if (aggMode === "annual")  return isStorage ? aggregateWaterYearEnd(rawData, keys) : aggregateWaterYear(rawData, keys, annualAvgKeys);
    return rawData;
  }, [rawData, keys, aggMode, isStorage, annualAvgKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Storage zone data (only in raw time-series mode) ---
  const zoneKeys = useMemo(() => {
    if (!zoneSeries || Object.keys(zoneSeries).length === 0 || aggMode !== "raw") return [];
    return Object.keys(zoneSeries).sort((a, b) => {
      const na = parseInt((a.match(/_(\d+)$/) || [])[1] || "0", 10);
      const nb = parseInt((b.match(/_(\d+)$/) || [])[1] || "0", 10);
      return na - nb;
    });
  }, [zoneSeries, aggMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoneKeySet = useMemo(() => new Set(zoneKeys), [zoneKeys]);

  const chartData = useMemo(() => {
    if (zoneKeys.length === 0) return data;
    const zoneRaw = buildChartData(zoneSeries, dateRange);
    const zoneMap = new Map(zoneRaw.map((r) => [r.date, r]));
    return data.map((row) => {
      const zr = zoneMap.get(row.date);
      if (!zr) return row;
      const merged = { ...row };
      for (const zk of zoneKeys) {
        if (zr[zk] != null) merged[zk] = zr[zk];
      }
      return merged;
    });
  }, [data, zoneKeys, zoneSeries, dateRange]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasZones = zoneKeys.length > 0;
  const visibleKeys = keys.filter((k) => !hidden.has(k));

  const allVals = chartData.flatMap((row) =>
    visibleKeys.map((k) => row[k]).filter((v) => v != null && !isNaN(v))
  );
  // When zones are present, y-domain should include zone cumulative max
  const zoneMax = useMemo(() => {
    if (!hasZones) return 0;
    let mx = 0;
    for (const row of chartData) {
      let cum = 0;
      for (const zk of zoneKeys) {
        cum += row[zk] ?? 0;
      }
      if (cum > mx) mx = cum;
    }
    return mx;
  }, [chartData, hasZones, zoneKeys]);

  const meanVal = allVals.length ? allVals.reduce((a, b) => a + b, 0) / allVals.length : 0;
  const yDomain = useMemo(() => {
    if (allVals.length === 0) return ["auto", "auto"];
    const mn = Math.min(...allVals);
    const mx = Math.max(...allVals, zoneMax);
    const pad = (mx - mn) * 0.05 || Math.abs(mx) * 0.05 || 1;
    return [Math.min(mn - pad, 0), Math.max(mx + pad, 0)];
  }, [hidden, data, zoneMax]); // eslint-disable-line react-hooks/exhaustive-deps

  const yearTicks = useMemo(
    () => aggMode === "raw" ? computeYearTicks(chartData) : undefined,
    [chartData, aggMode] // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (keys.length === 0 || chartData.length === 0) return null;

  function toggle(key) { setHidden((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; }); }

  const isBar = useBarForAnnual && aggMode === "annual";
  const isAgg = aggMode !== "raw";
  const xTickFmt = isAgg ? undefined : (v) => v.slice(0, 4);
  // Use ComposedChart when zones are present so we can mix Area + Line
  const ChartComp = hasZones ? ComposedChart : (isBar ? BarChart : LineChart);

  return (
    <div className="mb-5">
      <button onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1 w-full text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300 mb-1">
        <span className="text-gray-600">{collapsed ? "\u25B8" : "\u25BE"}</span>{title}
      </button>
      {!collapsed && <ToggleLegend keys={keys} hidden={hidden} onToggle={toggle} keyLabels={keyLabels} />}
      {!collapsed && (
        <ResponsiveContainer width="100%" height={180}>
          <ChartComp data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="date" ticks={yearTicks} tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={xTickFmt}
              interval={isAgg && aggMode !== "annual" ? 0 : undefined} />
            <YAxis domain={yDomain} tick={{ fontSize: 10, fill: "#6b7280" }}
              tickFormatter={(v) => Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)} />
            <Tooltip content={<ChartTooltip yUnit={yUnit} keyLabels={keyLabels} excludeKeys={hasZones ? zoneKeySet : null} />} />
            <ReferenceLine y={0} stroke="#4b5563" strokeWidth={1} />
            {aggMode === "raw" && chartData.filter((r) => r.date.slice(5, 7) === "09").map((r) =>
              <ReferenceLine key={`oct-${r.date}`} x={r.date} stroke="#374151" strokeWidth={0.5} opacity={0.7} />
            )}
            {aggMode === "raw" && meanVal > 0 && (
              <ReferenceLine y={meanVal} stroke="#374151" strokeDasharray="4 2"
                label={{ value: "avg", position: "right", fontSize: 10, fill: "#4b5563" }} />
            )}
            {/* Storage zone shaded areas — stacked from bottom */}
            {hasZones && zoneKeys.map((zk, i) => (
              <Area key={`zone_${zk}`} type="monotone" dataKey={zk}
                stackId="zones" fill={ZONE_COLORS[i % ZONE_COLORS.length]}
                fillOpacity={0.25} stroke="none" isAnimationActive={false}
                dot={false} activeDot={false} legendType="none" />
            ))}
            {isBar
              ? keys.map((key, i) => (
                  <Bar key={key} dataKey={key} fill={seriesColor(key, i)} fillOpacity={0.8}
                    hide={hidden.has(key)} isAnimationActive={false} />
                ))
              : keys.map((key, i) => (
                  <Line key={key} type="monotone" dataKey={key} stroke={seriesColor(key, i)}
                    hide={hidden.has(key)} dot={isAgg ? { r: 2 } : false} strokeWidth={1.5} connectNulls activeDot={{ r: 3 }} isAnimationActive={false} />
                ))
            }
            {refBounds.map((b) => (
              <ReferenceLine key={b.type} y={b.bound} stroke={REF_COLORS[b.type] ?? "#6b7280"}
                strokeDasharray="6 3" strokeWidth={1.5} />
            ))}
          </ChartComp>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stacked area chart  (in/out flows) — uses pos/neg color palettes
// ---------------------------------------------------------------------------

function StackedFlowChart({ title, series, metadata, dateRange, convertFn = null, aggMode = "raw" }) {
  const [hidden, setHidden] = useState(new Set());
  const [collapsed, setCollapsed] = useState(false);

  const keys = Object.keys(series).sort((a, b) => {
    const da = metadata?.[a]?.direction === "out" ? 1 : 0;
    const db = metadata?.[b]?.direction === "out" ? 1 : 0;
    return da - db;
  });
  const negateKeys = useMemo(
    () => new Set(keys.filter((k) => metadata?.[k]?.direction === "out")),
    [keys, metadata] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const keyLabels = useMemo(
    () => Object.fromEntries(keys.map((k) => [k, (metadata?.[k]?.direction === "out" ? "(out) " : "(in) ") + k])),
    [keys, metadata] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const cfsKeys = useMemo(
    () => new Set(keys.filter((k) => (metadata?.[k]?.units || "").toUpperCase() === "CFS")),
    [keys, metadata] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const yUnit = cfsKeys.size > 0
    ? (convertFn ? " TAF" : " CFS")
    : (() => { for (const k of keys) { const u = metadata?.[k]?.units; if (u) return ` ${u}`; } return ""; })();

  const rawData = buildChartData(series, dateRange, negateKeys, convertFn, cfsKeys.size > 0 ? cfsKeys : null);
  // CFS keys with no conversion remain as rates → average at annual scale
  const annualAvgKeys = convertFn ? null : (cfsKeys.size > 0 ? cfsKeys : null);
  const data = useMemo(() => applyAggregation(rawData, keys, aggMode, annualAvgKeys), [rawData, keys, aggMode, annualAvgKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build colour map using pos/neg palettes
  const keyColorMap = useMemo(() => {
    const m = {};
    let posIdx = 0, negIdx = 0;
    for (const k of keys) {
      const isNeg = negateKeys.has(k);
      m[k] = flowSeriesColor(k, isNeg, isNeg ? negIdx++ : posIdx++);
    }
    return m;
  }, [keys, negateKeys]);

  const stackedData = useMemo(() => {
    if (data.length === 0) return data;
    const inKeys  = keys.filter((k) => !negateKeys.has(k) && !hidden.has(k));
    const outKeys = keys.filter((k) =>  negateKeys.has(k) && !hidden.has(k));
    return data.map((row) => {
      const extra = {};
      let accIn = 0;
      for (const k of inKeys) {
        const v = Math.max(row[k] ?? 0, 0);
        extra[`_stk_${k}`] = v;
        accIn += v;
        extra[`_top_${k}`] = accIn;
      }
      for (const k of outKeys) {
        const v = Math.max(row[k] ?? 0, 0);
        extra[`_stk_rev_${k}`] = v;
        accIn += v;
        extra[`_top_rev_${k}`] = accIn;
      }
      let accOut = 0;
      for (const k of outKeys) {
        const v = Math.min(row[k] ?? 0, 0);
        extra[`_stk_${k}`] = v;
        accOut += v;
        extra[`_top_${k}`] = accOut;
      }
      for (const k of inKeys) {
        const v = Math.min(row[k] ?? 0, 0);
        extra[`_stk_rev_${k}`] = v;
        accOut += v;
        extra[`_top_rev_${k}`] = accOut;
      }
      return { ...row, ...extra };
    });
  }, [data, keys, negateKeys, hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  const yDomain = useMemo(() => {
    if (stackedData.length === 0) return ["auto", "auto"];
    let mn = 0, mx = 0;
    for (const row of stackedData) {
      for (const k of Object.keys(row)) {
        if (k.startsWith("_top_") || k.startsWith("_top_rev_")) {
          const v = row[k];
          if (typeof v === "number" && !isNaN(v)) {
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
        }
      }
    }
    const pad = (mx - mn) * 0.05 || 1;
    return [mn - pad, mx + pad];
  }, [stackedData]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasReverseFlow = useMemo(() => {
    const s = new Set();
    for (const row of stackedData) {
      for (const k of keys) {
        if (s.has(k)) continue;
        const v = row[`_stk_rev_${k}`];
        if (v != null && v !== 0) s.add(k);
      }
    }
    return s;
  }, [stackedData, keys]);

  const yearTicks = useMemo(
    () => aggMode === "raw" ? computeYearTicks(data) : undefined,
    [data, aggMode] // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (keys.length === 0 || data.length === 0) return null;

  function toggle(key) { setHidden((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; }); }

  const isMonthly = aggMode === "monthly";
  const xTickFmt = aggMode === "raw" ? (v) => v.slice(0, 4) : undefined;

  return (
    <div className="mb-5">
      <button onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1 w-full text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300 mb-1">
        <span className="text-gray-600">{collapsed ? "\u25B8" : "\u25BE"}</span>{title}
      </button>
      {!collapsed && (
        <div className="flex flex-wrap gap-1 mt-1 mb-2">
          {keys.map((key) => {
            const isHidden = hidden.has(key);
            return (
              <button key={key} onClick={() => toggle(key)}
                className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-opacity ${
                  isHidden ? "opacity-30 border-gray-700 text-gray-600" : "opacity-100 border-gray-600 text-gray-300"
                }`}
              >
                <span style={{ display: "inline-block", width: 12, height: 2, background: keyColorMap[key], borderRadius: 1 }} />
                {keyLabels[key] ?? key}
              </button>
            );
          })}
        </div>
      )}
      {!collapsed && (
        <ResponsiveContainer width="100%" height={180}>
          <ComposedChart data={stackedData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="date" ticks={yearTicks} tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={xTickFmt}
              interval={isMonthly ? 0 : undefined} />
            <YAxis domain={yDomain} tick={{ fontSize: 10, fill: "#6b7280" }}
              tickFormatter={(v) => Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)} />
            <Tooltip content={<ChartTooltip yUnit={yUnit} keyLabels={keyLabels} />} />
            <ReferenceLine y={0} stroke="#4b5563" strokeWidth={1} />
            {aggMode === "raw" && data.filter((r) => r.date.slice(5, 7) === "09").map((r) =>
              <ReferenceLine key={`oct-${r.date}`} x={r.date} stroke="#374151" strokeWidth={0.5} opacity={0.7} />
            )}
            {keys.map((key) => (
              <Area key={key} type="monotone" dataKey={`_stk_${key}`} stroke="none"
                fill={keyColorMap[key]} fillOpacity={0.3}
                stackId={negateKeys.has(key) ? "out" : "in"}
                hide={hidden.has(key)} dot={false} connectNulls isAnimationActive={false} />
            ))}
            {keys.filter((k) => hasReverseFlow.has(k)).map((key) => (
              <Area key={`_rev_${key}`} type="monotone" dataKey={`_stk_rev_${key}`} stroke="none"
                fill={keyColorMap[key]} fillOpacity={0.15}
                stackId={negateKeys.has(key) ? "in" : "out"}
                hide={hidden.has(key)} dot={false} connectNulls isAnimationActive={false}
                legendType="none" />
            ))}
            {keys.map((key) => (
              <Line key={`_line_${key}`} type="monotone" dataKey={`_top_${key}`}
                stroke={keyColorMap[key]} strokeWidth={1.5} dot={false}
                hide={hidden.has(key)} connectNulls activeDot={false} isAnimationActive={false} />
            ))}
            {keys.filter((k) => hasReverseFlow.has(k)).map((key) => (
              <Line key={`_revline_${key}`} type="monotone" dataKey={`_top_rev_${key}`}
                stroke={keyColorMap[key]} strokeWidth={1} strokeDasharray="4 2" dot={false}
                hide={hidden.has(key)} connectNulls activeDot={false} isAnimationActive={false} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Water Balance stacked-area chart
// ---------------------------------------------------------------------------

function WaterBalanceChart({ series, metadata, dateRange, convertFn = null, aggMode = "raw" }) {
  const [hidden, setHidden]       = useState(new Set());
  const [collapsed, setCollapsed] = useState(false);

  const { wbSeries, wbUnits, presentLabels } = useMemo(() => {
    const agg = {};
    const unitForLabel = {};
    for (const [key, rows] of Object.entries(series)) {
      const rawCpart = (metadata?.[key]?.c_part || metadata?.[key]?.kind || "").toUpperCase().replace(/ /g, "-");
      const term = WB_TERMS[rawCpart];
      if (!term) continue;
      const { label } = term;
      if (!agg[label]) agg[label] = {};
      const u = (metadata?.[key]?.units || "").toUpperCase();
      if (u) unitForLabel[label] = u;
      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const dateKey = String(row[0]).slice(0, 10);
        const val = typeof row[1] === "number" ? row[1] : Number(row[1]);
        if (!isNaN(val)) agg[label][dateKey] = (agg[label][dateKey] ?? 0) + val;
      }
    }
    const wbSeries = {};
    for (const [label, dateMap] of Object.entries(agg)) {
      wbSeries[label] = Object.entries(dateMap).map(([d, v]) => [d, v]);
    }
    const presentLabels = WB_ORDER.filter((l) => l in wbSeries);
    return { wbSeries, wbUnits: unitForLabel, presentLabels };
  }, [series, metadata]); // eslint-disable-line react-hooks/exhaustive-deps

  const negateLabels = useMemo(
    () => new Set(presentLabels.filter((l) => !WB_POSITIVE.has(l))),
    [presentLabels], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const cfsLabels = useMemo(
    () => new Set(presentLabels.filter((l) => (wbUnits[l] || "").toUpperCase() === "CFS")),
    [presentLabels, wbUnits], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const yUnit = cfsLabels.size > 0
    ? (convertFn ? " TAF" : " CFS")
    : (() => { for (const l of presentLabels) { const u = wbUnits[l]; if (u) return ` ${u}`; } return ""; })();

  const rawData = buildChartData(wbSeries, dateRange, negateLabels, convertFn, cfsLabels.size > 0 ? cfsLabels : null);
  const annualAvgLabels = convertFn ? null : (cfsLabels.size > 0 ? cfsLabels : null);
  const data = useMemo(() => applyAggregation(rawData, presentLabels, aggMode, annualAvgLabels), [rawData, presentLabels, aggMode, annualAvgLabels]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleLabels = presentLabels.filter((l) => !hidden.has(l));
  const yDomain = useMemo(() => {
    const vals = data.flatMap((row) =>
      visibleLabels.map((l) => row[l]).filter((v) => v != null && !isNaN(v))
    );
    if (vals.length === 0) return ["auto", "auto"];
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const pad = (mx - mn) * 0.05 || Math.abs(mx) * 0.05 || 1;
    return [Math.min(mn - pad, 0), Math.max(mx + pad, 0)];
  }, [hidden, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const yearTicks = useMemo(
    () => aggMode === "raw" ? computeYearTicks(data) : undefined,
    [data, aggMode] // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (presentLabels.length === 0 || data.length === 0) return null;

  function toggle(l) { setHidden((p) => { const n = new Set(p); n.has(l) ? n.delete(l) : n.add(l); return n; }); }

  const isMonthly = aggMode === "monthly";
  const xTickFmt = aggMode === "raw" ? (v) => v.slice(0, 4) : undefined;

  return (
    <div className="mb-5">
      <button onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1 w-full text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300 mb-1">
        <span className="text-gray-600">{collapsed ? "\u25B8" : "\u25BE"}</span>Water Balance
      </button>
      {!collapsed && (
        <div className="flex flex-wrap gap-1 mt-1 mb-2">
          {presentLabels.map((label) => (
            <button key={label} onClick={() => toggle(label)}
              className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-opacity ${
                hidden.has(label) ? "opacity-30 border-gray-700 text-gray-600" : "opacity-100 border-gray-600 text-gray-300"
              }`}
            >
              <span style={{ display: "inline-block", width: 12, height: 2, background: WB_COLORS[label], borderRadius: 1 }} />
              {label}
            </button>
          ))}
        </div>
      )}
      {!collapsed && (
        <ResponsiveContainer width="100%" height={180}>
          <ComposedChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="date" ticks={yearTicks} tick={{ fontSize: 10, fill: "#6b7280" }} tickFormatter={xTickFmt}
              interval={isMonthly ? 0 : undefined} />
            <YAxis domain={yDomain} tick={{ fontSize: 10, fill: "#6b7280" }}
              tickFormatter={(v) => Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)} />
            <Tooltip content={<ChartTooltip yUnit={yUnit} />} />
            <ReferenceLine y={0} stroke="#4b5563" strokeWidth={1} />
            {aggMode === "raw" && data.filter((r) => r.date.slice(5, 7) === "09").map((r) =>
              <ReferenceLine key={`oct-${r.date}`} x={r.date} stroke="#374151" strokeWidth={0.5} opacity={0.7} />
            )}
            {presentLabels.map((label) => (
              <Area key={label} type="monotone" dataKey={label}
                stroke={WB_COLORS[label]} fill={WB_COLORS[label]}
                fillOpacity={0.3} strokeWidth={1.5}
                stackId={WB_POSITIVE.has(label) ? "in" : "out"}
                hide={hidden.has(label)} dot={false} connectNulls isAnimationActive={false} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default function ResultsChart({ series, metadata, dateRange, displayUnit, onDisplayUnitChange, aggMode, onAggModeChange }) {
  const convertFn = displayUnit === "TAF" ? cfsToTaf : null;

  const { arcFlows, storage, storageZones, balance } = splitSeries(series, metadata);

  const hasArcFlows = Object.keys(arcFlows).length > 0;
  const hasCfsArcFlows = Object.keys(arcFlows).some((k) => (metadata?.[k]?.units || "").toUpperCase() === "CFS");
  const hasCfsBalance = Object.keys(balance).some((k) => (metadata?.[k]?.units || "").toUpperCase() === "CFS");
  const showToggle = hasCfsArcFlows || hasCfsBalance;
  const storageUnit = (() => { for (const k of Object.keys(storage)) { const u = metadata?.[k]?.units; if (u) return ` ${u}`; } return " TAF"; })();

  const otherBalance = useMemo(() => {
    const out = {};
    for (const [k, v] of Object.entries(balance)) {
      const cp = (metadata?.[k]?.c_part || metadata?.[k]?.kind || "").toUpperCase().replace(/ /g, "-");
      if (!WB_TERMS_SET.has(cp)) out[k] = v;
    }
    return out;
  }, [balance, metadata]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasCfsOther = Object.keys(otherBalance).some((k) => (metadata?.[k]?.units || "").toUpperCase() === "CFS");
  const otherUnit = (() => {
    if (hasCfsOther) return displayUnit === "TAF" ? " TAF" : " CFS";
    for (const k of Object.keys(otherBalance)) { const u = metadata?.[k]?.units; if (u) return ` ${u}`; }
    return "";
  })();

  return (
    <div>
      {/* Top controls row: units + aggregation mode */}
      <div className="flex items-center gap-3 flex-wrap mb-3">
        {showToggle && (
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-gray-500 mr-1">Units:</span>
            {["CFS", "TAF"].map((u) => (
              <button key={u} onClick={() => onDisplayUnitChange(u)}
                className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                  displayUnit === u
                    ? "border-blue-500 text-blue-400 bg-blue-950"
                    : "border-gray-600 text-gray-400 hover:border-blue-400 hover:text-blue-400"
                }`}>{u}</button>
            ))}
          </div>
        )}
        <AggToggle mode={aggMode} onChange={onAggModeChange} />
      </div>

      {hasArcFlows && (
        <StackedFlowChart
          title="Arc Flows"
          series={arcFlows}
          metadata={metadata}
          dateRange={dateRange}
          convertFn={hasCfsArcFlows ? convertFn : null}
          aggMode={aggMode}
        />
      )}

      <LineChartPanel title="Storage" series={storage} metadata={metadata} yUnit={storageUnit} dateRange={dateRange} aggMode={aggMode} isStorage useBarForAnnual zoneSeries={storageZones} />

      <WaterBalanceChart
        series={balance}
        metadata={metadata}
        dateRange={dateRange}
        convertFn={hasCfsBalance ? convertFn : null}
        aggMode={aggMode}
      />

      <LineChartPanel
        title={hasArcFlows ? "Other" : "Flow"}
        series={otherBalance}
        metadata={metadata}
        yUnit={otherUnit}
        dateRange={dateRange}
        convertFn={hasCfsOther ? convertFn : null}
        aggMode={aggMode}
        useBarForAnnual={!hasArcFlows}
      />
    </div>
  );
}

