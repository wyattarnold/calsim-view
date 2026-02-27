/**
 * GwBudgetPanel — displays groundwater budget bar chart for a Water Budget Area.
 *
 * Fetches the GW budget data from the API when a WBA is selected and renders
 * a stacked bar chart with one bar per month, split by budget component.
 */

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { fetchGwBudget } from "../api/client.js";

// ---------------------------------------------------------------------------
// Budget component colours — cool tones for inflows, warm for outflows
// ---------------------------------------------------------------------------

const COMPONENT_COLORS = {
  PUMPING:          "#ef4444", // red  (outflow)
  NET_DEEP_PERC:    "#3b82f6", // blue (inflow)
  STRM_GW_INT:      "#06b6d4", // cyan (inflow/outflow)
  LATERAL_FLOW:     "#8b5cf6", // violet
  CHANGE_STORAGE:   "#f59e0b", // amber
  SMALL_WSHED:      "#10b981", // emerald
  SUBSIDENCE:       "#f97316", // orange
  TILE_DRAIN:       "#ec4899", // pink
  FLOW_BC:          "#84cc16", // lime
  HEAD_BC:          "#14b8a6", // teal
  GHB:              "#a78bfa", // light violet
};

const DEFAULT_COLOR = "#6b7280";

// ---------------------------------------------------------------------------
// Aggregation modes
// ---------------------------------------------------------------------------

const AGG_MODES = [
  { key: "raw",     label: "Time Series" },
  { key: "annual",  label: "Water Year" },
];

function waterYear(dateStr) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  return m >= 10 ? y + 1 : y;
}

// ---------------------------------------------------------------------------
// Data processing
// ---------------------------------------------------------------------------

function buildChartData(series, cPartLabels) {
  // series: { PUMPING: [[date, val], ...], NET_DEEP_PERC: [[date, val], ...], ... }
  const dateMap = {};
  const keys = Object.keys(series);

  for (const key of keys) {
    for (const [date, val] of series[key]) {
      if (!dateMap[date]) dateMap[date] = { date };
      dateMap[date][key] = val;
    }
  }

  const data = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
  return data;
}

function aggregateAnnual(data, keys) {
  const wyMap = {};
  for (const row of data) {
    const wy = waterYear(row.date);
    if (!wyMap[wy]) {
      wyMap[wy] = { date: `WY${wy}` };
      for (const k of keys) wyMap[wy][k] = 0;
    }
    for (const k of keys) {
      if (row[k] != null) wyMap[wy][k] += row[k];
    }
  }
  return Object.values(wyMap).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

function BudgetTooltip({ active, payload, label, cPartLabels, units }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-gray-900/95 border border-gray-600 rounded px-3 py-2 text-xs max-w-xs">
      <p className="font-semibold text-gray-300 mb-1">{label}</p>
      {payload
        .filter((p) => p.value !== 0)
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
        .map((p) => (
          <div key={p.dataKey} className="flex justify-between gap-3">
            <span style={{ color: p.fill }}>{cPartLabels[p.dataKey] || p.dataKey}</span>
            <span className="text-gray-200 font-mono">
              {p.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          </div>
        ))}
      <div className="mt-1 pt-1 border-t border-gray-700 flex justify-between gap-3">
        <span className="text-gray-400">Total</span>
        <span className="text-gray-200 font-mono font-semibold">
          {payload
            .reduce((s, p) => s + (p.value || 0), 0)
            .toLocaleString(undefined, { maximumFractionDigits: 0 })}{" "}
          <span className="text-gray-500 font-normal">{units}</span>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function GwBudgetPanel({ wbaId, activeStudy, onClose }) {
  const [aggMode, setAggMode] = useState("annual");
  const [hidden, setHidden] = useState(new Set());

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["gwBudget", wbaId, activeStudy],
    queryFn: () => fetchGwBudget(wbaId, activeStudy),
    enabled: !!wbaId,
    retry: false,
  });

  const cPartLabels = data?.c_part_labels || {};
  const units = data?.units || "AF";
  const keys = useMemo(() => Object.keys(data?.series || {}), [data]);

  const rawData = useMemo(
    () => (data?.series ? buildChartData(data.series, cPartLabels) : []),
    [data] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const chartData = useMemo(() => {
    if (aggMode === "annual") return aggregateAnnual(rawData, keys);
    return rawData;
  }, [rawData, keys, aggMode]);

  const visibleKeys = useMemo(() => keys.filter((k) => !hidden.has(k)), [keys, hidden]);

  const toggleKey = (key) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!wbaId) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500 text-sm px-6 text-center">
        <p className="text-2xl mb-3">💧</p>
        <p>Click a Water Budget Area polygon to view its groundwater budget.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700 shrink-0">
        <div>
          <h2 className="text-sm font-semibold text-blue-400">
            GW Budget — WBA {wbaId}
          </h2>
          <p className="text-[10px] text-gray-500">
            IWFM Groundwater Budget Components ({units})
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-gray-500 hover:text-gray-200 text-lg leading-none px-1"
          title="Close"
        >
          ×
        </button>
      </div>

      {/* Aggregation toggle */}
      <div className="px-4 py-1.5 border-b border-gray-700 shrink-0 flex items-center gap-1">
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

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {isLoading && (
          <div className="flex items-center justify-center h-40 text-gray-500 text-sm">
            Loading GW budget…
          </div>
        )}

        {isError && (
          <div className="px-4 py-6 text-center text-gray-500 text-sm">
            <p>No GW budget data for WBA {wbaId}.</p>
            <p className="text-xs text-gray-600 mt-1">{error?.message}</p>
          </div>
        )}

        {data && !isLoading && (
          <div className="px-2 py-3">
            {/* Legend with toggle */}
            <div className="flex flex-wrap gap-x-3 gap-y-1 px-2 mb-3">
              {keys.map((key) => {
                const isHidden = hidden.has(key);
                const color = COMPONENT_COLORS[key] || DEFAULT_COLOR;
                return (
                  <button
                    key={key}
                    onClick={() => toggleKey(key)}
                    className={`flex items-center gap-1 text-[10px] transition-opacity ${
                      isHidden ? "opacity-30" : "opacity-100"
                    }`}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-sm shrink-0"
                      style={{ background: color }}
                    />
                    <span className="text-gray-300">
                      {cPartLabels[key] || key}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Chart */}
            <ResponsiveContainer width="100%" height={320}>
              <BarChart
                data={chartData}
                margin={{ top: 5, right: 10, left: 5, bottom: 5 }}
                stackOffset="sign"
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "#9ca3af" }}
                  tickFormatter={(v) =>
                    aggMode === "annual"
                      ? v.replace("WY", "")
                      : v.slice(0, 7)
                  }
                  interval={aggMode === "annual" ? 4 : "preserveStartEnd"}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "#9ca3af" }}
                  tickFormatter={(v) =>
                    Math.abs(v) >= 1e6
                      ? `${(v / 1e6).toFixed(1)}M`
                      : Math.abs(v) >= 1e3
                        ? `${(v / 1e3).toFixed(0)}K`
                        : v.toFixed(0)
                  }
                  label={{
                    value: units,
                    angle: -90,
                    position: "insideLeft",
                    style: { fontSize: 10, fill: "#6b7280" },
                  }}
                />
                <Tooltip
                  content={
                    <BudgetTooltip cPartLabels={cPartLabels} units={units} />
                  }
                />
                {visibleKeys.map((key) => (
                  <Bar
                    key={key}
                    dataKey={key}
                    stackId="a"
                    fill={COMPONENT_COLORS[key] || DEFAULT_COLOR}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
