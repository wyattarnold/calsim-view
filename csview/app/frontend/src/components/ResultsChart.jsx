import { useState, useMemo } from "react";
import {
  ComposedChart,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

const COLORS = [
  "#3b82f6","#10b981","#f59e0b","#ef4444",
  "#8b5cf6","#06b6d4","#f97316","#84cc16",
];

const REF_COLORS = { LBC: "#10b981", UBC: "#ef4444", EQC: "#f59e0b" };

function seriesColor(key, index) {
  return COLORS[index % COLORS.length];
}

function shortKey(key) {
  if (key === "storage")  return "Storage";
  if (key === "flow")     return "Flow";
  if (key.startsWith("flow_out_")) return "(out) " + key.slice(9);
  if (key.startsWith("flow_in_"))  return "(in) "  + key.slice(8);
  if (key === "evaporation") return "(out) evaporation";
  if (key.startsWith("shortage_volume_")) return "ShortVol " + key.slice(16);
  if (key.startsWith("shortage_cost_"))   return "ShortCost " + key.slice(14);
  return key;
}

function buildChartData(seriesMap, dateRange, negateKeys = null) {
  const [startYear, endYear] = dateRange ?? [null, null];
  const dateMap = new Map();

  for (const [key, rows] of Object.entries(seriesMap)) {
    const sign = negateKeys?.has(key) ? -1 : 1;
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const [dateRaw, value] = row;
      const dateKey = String(dateRaw).slice(0, 10);
      const year = dateKey.slice(0, 4);
      if (startYear && year < startYear) continue;
      if (endYear && year > endYear) continue;
      if (!dateMap.has(dateKey)) dateMap.set(dateKey, { date: dateKey });
      const num = typeof value === "number" ? value : Number(value);
      dateMap.get(dateKey)[key] = sign * num;
    }
  }

  return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// CalSim node types that have "storage" semantics
// CalSim 3 WRESL kind strings that belong to each chart group.
const KIND_STORAGE = new Set([
  "STORAGE", "STORAGE-ZONE", "GW-STORAGE", "GROUNDWATER",
]);
const KIND_FLOW = new Set([
  "CHANNEL", "FLOW", "ADD-FLOW", "INFLOW", "DIVERSION",
  "DELIVERY", "AG-DELIVERY", "URBAN-DELIVERY", "URBAN-DEMAND",
  "RETURN-FLOW", "SEEPAGE", "GROUNDWATER-FLOW",
]);
// CalSim 3 variable-name prefix → chart group (used when kind is unknown)
const PREFIX_GROUP = {
  "S_":    "storage",
  "E_":    "other",    // evaporation — standalone
  "C_":    "flow",
  "D_":    "flow",
  "I_":    "flow",
  "R_":    "flow",
  "G_":    "flow",
  "T_":    "flow",
  "WTS_":  "flow",
  "SHRTG_": "shortage",
};

function groupSeries(series, metadata) {
  const groups = { storage: {}, flow: {}, shortage: {}, other: {} };

  for (const [key, data] of Object.entries(series)) {
    // Prefer the explicit `kind` from results metadata
    const kind = ((metadata?.[key]?.kind) || "").toUpperCase().replace(/ /g, "-");
    if (kind && KIND_STORAGE.has(kind)) {
      groups.storage[key] = data;
    } else if (kind === "SHORTAGE") {
      groups.shortage[key] = data;
    } else if (kind && KIND_FLOW.has(kind)) {
      groups.flow[key] = data;
    } else {
      // Fallback: CalSim variable-name prefix heuristic
      const up = key.toUpperCase();
      let matched = false;
      for (const [pfx, grp] of Object.entries(PREFIX_GROUP)) {
        if (up.startsWith(pfx)) {
          groups[grp][key] = data;
          matched = true;
          break;
        }
      }
      if (!matched) groups.other[key] = data;
    }
  }
  return groups;
}

/** Return the dominant unit for a group from metadata, or a fallback string. */
function groupUnit(groupData, metadata, fallback) {
  for (const key of Object.keys(groupData)) {
    const u = metadata?.[key]?.units;
    if (u) return ` ${u}`;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Toggleable legend
// ---------------------------------------------------------------------------

function ToggleLegend({ keys, hidden, onToggle }) {
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1 mb-2">
      {keys.map((key, i) => {
        const isHidden = hidden.has(key);
        return (
          <button
            key={key}
            onClick={() => onToggle(key)}
            className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-opacity ${
              isHidden
                ? "opacity-30 border-gray-700 text-gray-600"
                : "opacity-100 border-gray-600 text-gray-300"
            }`}
          >
            <span style={{ display: "inline-block", width: 12, height: 2, background: seriesColor(key, i), borderRadius: 1 }} />
            {shortKey(key)}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

function ChartTooltip({ active, payload, label, yUnit = "" }) {
  if (!active || !payload?.length) return null;
  const items = payload.filter((p) => !String(p.dataKey).startsWith("_top_"));
  if (items.length === 0) return null;
  return (
    <div style={{
      background: "rgba(17, 24, 39, 0.85)",
      border: "1px solid #374151",
      borderRadius: 4,
      fontSize: 11,
      padding: "6px 10px",
      backdropFilter: "blur(4px)",
    }}>
      <p style={{ color: "#9ca3af", marginBottom: 4 }}>{label}</p>
      {items.map((item) => (
        <p key={item.dataKey} style={{ color: item.color, margin: "1px 0" }}>
          {shortKey(String(item.dataKey))}: {typeof item.value === "number" ? item.value.toFixed(2) : item.value}{yUnit}
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single chart
// ---------------------------------------------------------------------------

function Chart({ title, series, yLabel, yUnit = "", dateRange, refBounds = [], stacked = false, negateKeys = null }) {
  const [hidden, setHidden] = useState(new Set());
  const [collapsed, setCollapsed] = useState(false);

  const keys = Object.keys(series);
  const data = buildChartData(series, dateRange, negateKeys);
  const visibleKeys = keys.filter((k) => !hidden.has(k));

  const allVals = data.flatMap((row) =>
    visibleKeys.map((k) => row[k]).filter((v) => v != null && !isNaN(v))
  );
  const meanVal = allVals.length ? allVals.reduce((a, b) => a + b, 0) / allVals.length : 0;
  const yDomain = useMemo(() => {
    if (allVals.length === 0) return ["auto", "auto"];
    const mn = Math.min(...allVals);
    const mx = Math.max(...allVals);
    const pad = (mx - mn) * 0.05 || Math.abs(mx) * 0.05 || 1;
    return [mn - pad, mx + pad];
  }, [hidden, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const stackedLineData = useMemo(() => {
    if (!stacked || data.length === 0) return data;
    const inKeys  = keys.filter((k) => !negateKeys?.has(k));
    const outKeys = keys.filter((k) =>  negateKeys?.has(k));
    return data.map((row) => {
      const extra = {};
      let acc = 0;
      for (const k of inKeys)  { acc += hidden.has(k) ? 0 : (row[k] ?? 0); extra[`_top_${k}`] = acc; }
      acc = 0;
      for (const k of outKeys) { acc += hidden.has(k) ? 0 : (row[k] ?? 0); extra[`_top_${k}`] = acc; }
      return { ...row, ...extra };
    });
  }, [stacked, data, keys, negateKeys, hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  const yearTicks = useMemo(() => {
    const seen = new Set();
    return data
      .filter((row) => { const y = row.date.slice(0, 4); if (seen.has(y)) return false; seen.add(y); return true; })
      .map((row) => row.date);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (keys.length === 0 || data.length === 0) return null;

  function toggleSeries(key) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <div className="mb-5">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1 w-full text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300 mb-1"
      >
        <span className="text-gray-600">{collapsed ? "▸" : "▾"}</span>
        {title}
      </button>
      {!collapsed && <ToggleLegend keys={keys} hidden={hidden} onToggle={toggleSeries} />}
      {!collapsed && (
        <ResponsiveContainer width="100%" height={180}>
          {stacked ? (
            <ComposedChart data={stackedLineData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="date" ticks={yearTicks} tick={{ fontSize: 8, fill: "#6b7280" }} tickFormatter={(v) => v.slice(0, 4)} />
              <YAxis domain={yDomain} tick={{ fontSize: 8, fill: "#6b7280" }}
                tickFormatter={(v) => Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)} />
              <Tooltip content={<ChartTooltip yUnit={yUnit} />} />
              <ReferenceLine y={0} stroke="#4b5563" strokeWidth={1} />
              {keys.map((key, i) => (
                <Area key={key} type="monotone" dataKey={key} stroke="none" fill={seriesColor(key, i)}
                  fillOpacity={0.25} stackId={negateKeys?.has(key) ? "out" : "in"}
                  hide={hidden.has(key)} dot={false} connectNulls isAnimationActive={false} />
              ))}
              {[...keys].reverse().map((key) => {
                const i = keys.indexOf(key);
                return (
                  <Line key={`_line_${key}`} type="monotone" dataKey={`_top_${key}`}
                    stroke={seriesColor(key, i)} strokeWidth={1} dot={false}
                    hide={hidden.has(key)} connectNulls activeDot={false} isAnimationActive={false} />
                );
              })}
            </ComposedChart>
          ) : (
            <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis dataKey="date" ticks={yearTicks} tick={{ fontSize: 8, fill: "#6b7280" }} tickFormatter={(v) => v.slice(0, 4)} />
              <YAxis domain={yDomain} tick={{ fontSize: 8, fill: "#6b7280" }}
                tickFormatter={(v) => Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)}
                label={yLabel ? { value: yLabel, angle: -90, position: "insideLeft", style: { fontSize: 8, fill: "#4b5563" } } : undefined} />
              <Tooltip content={<ChartTooltip yUnit={yUnit} />} />
              {data.filter((row) => row.date.slice(5, 7) === "09")
                .map((row) => <ReferenceLine key={`oct-${row.date}`} x={row.date} stroke="#374151" strokeWidth={0.5} opacity={0.7} />)}
              {meanVal > 0 && (
                <ReferenceLine y={meanVal} stroke="#374151" strokeDasharray="4 2"
                  label={{ value: "avg", position: "right", fontSize: 8, fill: "#4b5563" }} />
              )}
              {keys.map((key, i) => (
                <Line key={key} type="monotone" dataKey={key} stroke={seriesColor(key, i)}
                  hide={hidden.has(key)} dot={false} strokeWidth={1.5} connectNulls activeDot={{ r: 3 }} />
              ))}
              {refBounds.map((b) => (
                <ReferenceLine key={b.type} y={b.bound} stroke={REF_COLORS[b.type] ?? "#6b7280"}
                  strokeDasharray="6 3" strokeWidth={1.5} />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default function ResultsChart({ series, metadata, dateRange }) {
  const groups = groupSeries(series, metadata);

  const storageUnit = groupUnit(groups.storage, metadata, " TAF");
  const flowUnit    = groupUnit(groups.flow,    metadata, " CFS");
  const shortUnit   = groupUnit(groups.shortage, metadata, " CFS");

  return (
    <div>
      <Chart title="Storage"  series={groups.storage}  yUnit={storageUnit} dateRange={dateRange} />
      <Chart title="Flow"     series={groups.flow}     yUnit={flowUnit}    dateRange={dateRange} />
      <Chart title="Shortage" series={groups.shortage} yUnit={shortUnit}   dateRange={dateRange} />
      <Chart title="Other"    series={groups.other}                        dateRange={dateRange} />
    </div>
  );
}
