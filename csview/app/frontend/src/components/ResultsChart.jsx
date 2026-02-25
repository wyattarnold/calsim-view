import { useState, useMemo } from "react";
import {
  ComposedChart,
  LineChart,
  Line,
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

/** Display label for a series key, using an optional override map. */
function shortKey(key, keyLabels = {}) {
  return keyLabels[key] ?? key;
}

// ---------------------------------------------------------------------------
// Unit conversion helpers
// ---------------------------------------------------------------------------

function daysInMonth(dateKey) {
  const year  = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  return new Date(year, month, 0).getDate();
}

function cfsToTaf(value, dateKey) {
  return value * daysInMonth(dateKey) * 86400 / 43560 / 1000;
}

// ---------------------------------------------------------------------------
// Data builders
// ---------------------------------------------------------------------------

function buildChartData(seriesMap, dateRange, negateKeys = null, convertFn = null, convertKeys = null) {
  // convertKeys: Set of keys to apply convertFn to; null = apply to all keys.
  const [startYear, endYear] = dateRange ?? [null, null];
  const dateMap = new Map();

  for (const [key, rows] of Object.entries(seriesMap)) {
    const sign = negateKeys?.has(key) ? -1 : 1;
    const shouldConvert = convertFn && (convertKeys === null || convertKeys.has(key));
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const [dateRaw, value] = row;
      const dateKey = String(dateRaw).slice(0, 10);
      const year = dateKey.slice(0, 4);
      if (startYear && year < startYear) continue;
      if (endYear && year > endYear) continue;
      if (!dateMap.has(dateKey)) dateMap.set(dateKey, { date: dateKey });
      let num = typeof value === "number" ? value : Number(value);
      if (shouldConvert) num = convertFn(num, dateKey);
      dateMap.get(dateKey)[key] = sign * num;
    }
  }

  return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Series splitting
// ---------------------------------------------------------------------------

const KIND_STORAGE = new Set([
  "STORAGE", "STORAGE-ZONE", "GW-STORAGE", "GROUNDWATER",
]);

/**
 * Split the flat series/metadata into logical groups:
 *   arcFlows  â€” series the backend tagged with direction "in" / "out"
 *   storage   â€” series with a storage kind
 *   balance   â€” everything else (node water-budget terms, single arc, etc.)
 */
// C-part kinds to suppress entirely from all charts.
const SUPPRESSED_KINDS = new Set(["ANNUAL-APPLIED-WATER"]);

function splitSeries(series, metadata) {
  const arcFlows = {};
  const storage  = {};
  const balance  = {};

  for (const [key, data] of Object.entries(series)) {
    // Suppress surface-area variables (A_* prefix).
    if (/^A_/i.test(key)) continue;
    const meta  = metadata?.[key] ?? {};
    const kind  = (meta.kind || "").toUpperCase().replace(/ /g, "-");
    if (SUPPRESSED_KINDS.has(kind)) continue;
    if (meta.direction) {
      arcFlows[key] = data;
    } else if (KIND_STORAGE.has(kind)) {
      storage[key] = data;
    } else {
      balance[key] = data;
    }
  }
  return { arcFlows, storage, balance };
}

// ---------------------------------------------------------------------------
// Toggleable legend
// ---------------------------------------------------------------------------

function ToggleLegend({ keys, hidden, onToggle, keyLabels = {} }) {
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
            {shortKey(key, keyLabels)}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

function ChartTooltip({ active, payload, label, yUnit = "", keyLabels = {} }) {
  if (!active || !payload?.length) return null;
  // Remap _stk_{key} entries → original key + unclamped value from the full row.
  // Filter out _top_{key}, _stk_rev_{key}, _top_rev_{key} entries (visual-only).
  const items = payload
    .filter((p) => {
      const dk = String(p.dataKey);
      return !dk.startsWith("_top_") && !dk.startsWith("_stk_rev_") && !dk.startsWith("_top_rev_");
    })
    .map((p) => {
      const dk = String(p.dataKey);
      if (dk.startsWith("_stk_")) {
        const origKey = dk.slice(5);
        const origVal = p.payload?.[origKey];
        return { ...p, dataKey: origKey, value: origVal };
      }
      return p;
    });
  if (items.length === 0) return null;
  return (
    <div style={{
      background: "rgba(17, 24, 39, 0.85)", border: "1px solid #374151",
      borderRadius: 4, fontSize: 11, padding: "6px 10px", backdropFilter: "blur(4px)",
    }}>
      <p style={{ color: "#9ca3af", marginBottom: 4 }}>{label}</p>
      {items.map((item) => (
        <p key={item.dataKey} style={{ color: item.color, margin: "1px 0" }}>
          {shortKey(String(item.dataKey), keyLabels)}: {typeof item.value === "number" ? Math.abs(item.value).toFixed(2) : item.value}{yUnit}
        </p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single chart  (plain lines)
// ---------------------------------------------------------------------------

function LineChartPanel({ title, series, metadata = {}, yUnit = "", dateRange, refBounds = [], keyLabels = {}, convertFn = null }) {
  const [hidden, setHidden] = useState(new Set());
  const [collapsed, setCollapsed] = useState(false);
  const keys = Object.keys(series);
  const cfsKeys = useMemo(() => new Set(keys.filter((k) => (metadata?.[k]?.units || "").toUpperCase() === "CFS")), [keys, metadata]); // eslint-disable-line react-hooks/exhaustive-deps
  const data = buildChartData(series, dateRange, null, convertFn, cfsKeys.size > 0 ? cfsKeys : null);
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
    return [Math.min(mn - pad, 0), Math.max(mx + pad, 0)];
  }, [hidden, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const yearTicks = useMemo(() => {
    const seen = new Set();
    return data.filter((row) => { const y = row.date.slice(0, 4); if (seen.has(y)) return false; seen.add(y); return true; }).map((r) => r.date);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (keys.length === 0 || data.length === 0) return null;

  function toggle(key) { setHidden((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; }); }

  return (
    <div className="mb-5">
      <button onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1 w-full text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300 mb-1">
        <span className="text-gray-600">{collapsed ? "\u25B8" : "\u25BE"}</span>{title}
      </button>
      {!collapsed && <ToggleLegend keys={keys} hidden={hidden} onToggle={toggle} keyLabels={keyLabels} />}
      {!collapsed && (
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="date" ticks={yearTicks} tick={{ fontSize: 8, fill: "#6b7280" }} tickFormatter={(v) => v.slice(0, 4)} />
            <YAxis domain={yDomain} tick={{ fontSize: 8, fill: "#6b7280" }}
              tickFormatter={(v) => Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)} />
            <Tooltip content={<ChartTooltip yUnit={yUnit} keyLabels={keyLabels} />} />
            <ReferenceLine y={0} stroke="#4b5563" strokeWidth={1} />
            {data.filter((r) => r.date.slice(5, 7) === "09").map((r) =>
              <ReferenceLine key={`oct-${r.date}`} x={r.date} stroke="#374151" strokeWidth={0.5} opacity={0.7} />
            )}
            {meanVal > 0 && (
              <ReferenceLine y={meanVal} stroke="#374151" strokeDasharray="4 2"
                label={{ value: "avg", position: "right", fontSize: 8, fill: "#4b5563" }} />
            )}
            {keys.map((key, i) => (
              <Line key={key} type="monotone" dataKey={key} stroke={seriesColor(key, i)}
                hide={hidden.has(key)} dot={false} strokeWidth={1.5} connectNulls activeDot={{ r: 3 }} isAnimationActive={false} />
            ))}
            {refBounds.map((b) => (
              <ReferenceLine key={b.type} y={b.bound} stroke={REF_COLORS[b.type] ?? "#6b7280"}
                strokeDasharray="6 3" strokeWidth={1.5} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stacked area chart  (in/out flows)
// ---------------------------------------------------------------------------

function StackedFlowChart({ title, series, metadata, dateRange, convertFn = null }) {
  const [hidden, setHidden] = useState(new Set());
  const [collapsed, setCollapsed] = useState(false);

  // Sort: (in) keys first, (out) keys after — drives render order and stacking order
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

  const data = buildChartData(series, dateRange, negateKeys, convertFn, cfsKeys.size > 0 ? cfsKeys : null);

  // Clamped stacking values + cumulative tops.
  //
  // Channels can carry negative flows (reverse direction).  After
  // buildChartData negates "out" keys, a reverse-flow "out" arc turns
  // positive.  We clamp each key to its expected sign for monotone
  // stacking (prevents outline line crossings), and place the
  // reverse-sign portion in the *opposite* stack as a synthetic
  // `_stk_rev_` / `_top_rev_` key so it remains visible.
  //
  // Only visible keys contribute — hidden Areas are excluded from
  // Recharts' own stack, so our manual tops must match.
  const stackedData = useMemo(() => {
    if (data.length === 0) return data;
    const inKeys  = keys.filter((k) => !negateKeys.has(k) && !hidden.has(k));
    const outKeys = keys.filter((k) =>  negateKeys.has(k) && !hidden.has(k));
    return data.map((row) => {
      const extra = {};
      // In-stack: expected inflow (≥ 0) + reverse outflow (≥ 0)
      let accIn = 0;
      for (const k of inKeys) {
        const v = Math.max(row[k] ?? 0, 0);
        extra[`_stk_${k}`] = v;
        accIn += v;
        extra[`_top_${k}`] = accIn;
      }
      for (const k of outKeys) {
        const v = Math.max(row[k] ?? 0, 0);  // reverse outflow → positive
        extra[`_stk_rev_${k}`] = v;
        accIn += v;
        extra[`_top_rev_${k}`] = accIn;
      }
      // Out-stack: expected outflow (≤ 0) + reverse inflow (≤ 0)
      let accOut = 0;
      for (const k of outKeys) {
        const v = Math.min(row[k] ?? 0, 0);
        extra[`_stk_${k}`] = v;
        accOut += v;
        extra[`_top_${k}`] = accOut;
      }
      for (const k of inKeys) {
        const v = Math.min(row[k] ?? 0, 0);  // reverse inflow → negative
        extra[`_stk_rev_${k}`] = v;
        accOut += v;
        extra[`_top_rev_${k}`] = accOut;
      }
      return { ...row, ...extra };
    });
  }, [data, keys, negateKeys, hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive y-domain from actual cumulative tops (not individual values)
  // so the axis scales to the full stacked extent.
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

  // Only render reverse-flow Areas/Lines for keys that actually have
  // non-zero reverse values (avoids flat placeholder lines at y=0).
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

  const yearTicks = useMemo(() => {
    const seen = new Set();
    return data.filter((row) => { const y = row.date.slice(0, 4); if (seen.has(y)) return false; seen.add(y); return true; }).map((r) => r.date);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (keys.length === 0 || data.length === 0) return null;

  function toggle(key) { setHidden((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; }); }

  return (
    <div className="mb-5">
      <button onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1 w-full text-left text-xs font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300 mb-1">
        <span className="text-gray-600">{collapsed ? "\u25B8" : "\u25BE"}</span>{title}
      </button>
      {!collapsed && <ToggleLegend keys={keys} hidden={hidden} onToggle={toggle} keyLabels={keyLabels} />}
      {!collapsed && (
        <ResponsiveContainer width="100%" height={180}>
          <ComposedChart data={stackedData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
            <XAxis dataKey="date" ticks={yearTicks} tick={{ fontSize: 8, fill: "#6b7280" }} tickFormatter={(v) => v.slice(0, 4)} />
            <YAxis domain={yDomain} tick={{ fontSize: 8, fill: "#6b7280" }}
              tickFormatter={(v) => Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)} />
            <Tooltip content={<ChartTooltip yUnit={yUnit} keyLabels={keyLabels} />} />
            <ReferenceLine y={0} stroke="#4b5563" strokeWidth={1} />
            {data.filter((r) => r.date.slice(5, 7) === "09").map((r) =>
              <ReferenceLine key={`oct-${r.date}`} x={r.date} stroke="#374151" strokeWidth={0.5} opacity={0.7} />
            )}
            {/* Pass 1: stacked fills using clamped _stk_ values, no stroke */}
            {keys.map((key, i) => (
              <Area key={key} type="monotone" dataKey={`_stk_${key}`} stroke="none"
                fill={seriesColor(key, i)} fillOpacity={0.3}
                stackId={negateKeys.has(key) ? "out" : "in"}
                hide={hidden.has(key)} dot={false} connectNulls isAnimationActive={false} />
            ))}
            {/* Pass 1b: reverse-flow fills in the opposite stack (same color, lighter) */}
            {keys.filter((k) => hasReverseFlow.has(k)).map((key, i) => (
              <Area key={`_rev_${key}`} type="monotone" dataKey={`_stk_rev_${key}`} stroke="none"
                fill={seriesColor(key, keys.indexOf(key))} fillOpacity={0.15}
                stackId={negateKeys.has(key) ? "in" : "out"}
                hide={hidden.has(key)} dot={false} connectNulls isAnimationActive={false}
                legendType="none" />
            ))}
            {/* Pass 2: outline Line at the cumulative top of each band */}
            {keys.map((key, i) => (
              <Line key={`_line_${key}`} type="monotone" dataKey={`_top_${key}`}
                stroke={seriesColor(key, i)} strokeWidth={1.5} dot={false}
                hide={hidden.has(key)} connectNulls activeDot={false} isAnimationActive={false} />
            ))}
            {/* Pass 2b: dashed outline for reverse-flow cumulative tops */}
            {keys.filter((k) => hasReverseFlow.has(k)).map((key) => (
              <Line key={`_revline_${key}`} type="monotone" dataKey={`_top_rev_${key}`}
                stroke={seriesColor(key, keys.indexOf(key))} strokeWidth={1} strokeDasharray="4 2" dot={false}
                hide={hidden.has(key)} connectNulls activeDot={false} isAnimationActive={false} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Water Balance stacked-area chart (GP/DG/RU above zero, DL/DP/EV/OS/RP/LF below)
// ---------------------------------------------------------------------------

const WB_TERMS = {
  "GW-PUMPING":        { label: "GP", positive: true  },
  "SW-DELIVERY-GROSS": { label: "DG", positive: true  },
  "SW_DELIVERY-GROSS": { label: "DG", positive: true  },
  "DELIVERY-LOSS":     { label: "DL", positive: false },
  "DEEP-PERCOLATION":  { label: "DP", positive: false },
  "PERCOLATION-LOSS":  { label: "DP", positive: false },
  "EVAPORATIVE-LOSS":  { label: "EV", positive: false },
  "EVAPORATION":       { label: "EV", positive: false },
  "OPERATING-SPILL":   { label: "OS", positive: false },
  "OPERATIONAL-SPILL": { label: "OS", positive: false },
  "SPILL-LOSS":        { label: "OS", positive: false },
  "RIPARIAN-MISC-ET":  { label: "RP", positive: false },
  "REUSE":             { label: "RU", positive: true  },
  "LATERAL-FLOW-LOSS": { label: "LF", positive: false },
};

const WB_ORDER   = ["GP", "DG", "RU", "DL", "DP", "EV", "OS", "RP", "LF"];
const WB_COLORS  = {
  GP: "#10b981", DG: "#3b82f6", RU: "#14b8a6",
  DL: "#ef4444", DP: "#f59e0b", EV: "#f97316",
  OS: "#8b5cf6", RP: "#ec4899", LF: "#eab308",
};
const WB_POSITIVE = new Set(["GP", "DG", "RU"]);

function WaterBalanceChart({ series, metadata, dateRange, convertFn = null }) {
  const [hidden, setHidden]       = useState(new Set());
  const [collapsed, setCollapsed] = useState(false);

  // Aggregate raw series into per-term totals: { label: [[dateKey, sumVal], ...] }
  const { wbSeries, wbUnits, presentLabels } = useMemo(() => {
    const agg = {};       // label → { dateKey: sum }
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

  const data = buildChartData(wbSeries, dateRange, negateLabels, convertFn, cfsLabels.size > 0 ? cfsLabels : null);

  const visibleLabels = presentLabels.filter((l) => !hidden.has(l));
  const allVals = data.flatMap((row) =>
    visibleLabels.map((l) => row[l]).filter((v) => v != null && !isNaN(v))
  );
  const yDomain = useMemo(() => {
    if (allVals.length === 0) return ["auto", "auto"];
    const mn = Math.min(...allVals);
    const mx = Math.max(...allVals);
    const pad = (mx - mn) * 0.05 || Math.abs(mx) * 0.05 || 1;
    return [Math.min(mn - pad, 0), Math.max(mx + pad, 0)];
  }, [hidden, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const yearTicks = useMemo(() => {
    const seen = new Set();
    return data
      .filter((row) => { const y = row.date.slice(0, 4); if (seen.has(y)) return false; seen.add(y); return true; })
      .map((r) => r.date);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (presentLabels.length === 0 || data.length === 0) return null;

  function toggle(l) { setHidden((p) => { const n = new Set(p); n.has(l) ? n.delete(l) : n.add(l); return n; }); }

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
            <XAxis dataKey="date" ticks={yearTicks} tick={{ fontSize: 8, fill: "#6b7280" }} tickFormatter={(v) => v.slice(0, 4)} />
            <YAxis domain={yDomain} tick={{ fontSize: 8, fill: "#6b7280" }}
              tickFormatter={(v) => Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)} />
            <Tooltip content={<ChartTooltip yUnit={yUnit} />} />
            <ReferenceLine y={0} stroke="#4b5563" strokeWidth={1} />
            {data.filter((r) => r.date.slice(5, 7) === "09").map((r) =>
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

export default function ResultsChart({ series, metadata, dateRange }) {
  const [displayUnit, setDisplayUnit] = useState("CFS");
  const convertFn = displayUnit === "TAF" ? cfsToTaf : null;

  const { arcFlows, storage, balance } = splitSeries(series, metadata);

  const hasArcFlows = Object.keys(arcFlows).length > 0;
  const hasCfsArcFlows = Object.keys(arcFlows).some((k) => (metadata?.[k]?.units || "").toUpperCase() === "CFS");
  const hasCfsBalance = Object.keys(balance).some((k) => (metadata?.[k]?.units || "").toUpperCase() === "CFS");
  const showToggle = hasCfsArcFlows || hasCfsBalance;
  const storageUnit = (() => { for (const k of Object.keys(storage)) { const u = metadata?.[k]?.units; if (u) return ` ${u}`; } return " TAF"; })();

  // Split balance into WB terms (→ stacked area) and everything else (→ line chart).
  const wbCpartSet = useMemo(() => new Set(Object.keys(WB_TERMS)), []);
  const otherBalance = useMemo(() => {
    const out = {};
    for (const [k, v] of Object.entries(balance)) {
      const cp = (metadata?.[k]?.c_part || metadata?.[k]?.kind || "").toUpperCase().replace(/ /g, "-");
      if (!wbCpartSet.has(cp)) out[k] = v;
    }
    return out;
  }, [balance, metadata, wbCpartSet]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasCfsOther = Object.keys(otherBalance).some((k) => (metadata?.[k]?.units || "").toUpperCase() === "CFS");
  const otherUnit = (() => {
    if (hasCfsOther) return displayUnit === "TAF" ? " TAF" : " CFS";
    for (const k of Object.keys(otherBalance)) { const u = metadata?.[k]?.units; if (u) return ` ${u}`; }
    return "";
  })();

  return (
    <div>
      {/* CFS/TAF toggle */}
      {showToggle && (
        <div className="flex items-center gap-1 mb-3">
          <span className="text-[10px] text-gray-500 mr-1">Units:</span>
          {["CFS", "TAF"].map((u) => (
            <button key={u} onClick={() => setDisplayUnit(u)}
              className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                displayUnit === u
                  ? "border-blue-500 text-blue-400 bg-blue-950"
                  : "border-gray-600 text-gray-400 hover:border-blue-400 hover:text-blue-400"
              }`}>{u}</button>
          ))}
        </div>
      )}

      {/* Arc Flows — stacked in/out */}
      {hasArcFlows && (
        <StackedFlowChart
          title="Arc Flows"
          series={arcFlows}
          metadata={metadata}
          dateRange={dateRange}
          convertFn={hasCfsArcFlows ? convertFn : null}
        />
      )}

      {/* Storage â€” plain lines, always TAF */}
      <LineChartPanel title="Storage" series={storage} metadata={metadata} yUnit={storageUnit} dateRange={dateRange} />

      {/* Water Balance — stacked area by GP/DG/RU/DL/DP/EV/OS/RP/LF terms */}
      <WaterBalanceChart
        series={balance}
        metadata={metadata}
        dateRange={dateRange}
        convertFn={hasCfsBalance ? convertFn : null}
      />

      {/* Other balance / single arc — plain lines */}
      <LineChartPanel
        title={hasArcFlows ? "Other" : "Flow"}
        series={otherBalance}
        metadata={metadata}
        yUnit={otherUnit}
        dateRange={dateRange}
        convertFn={hasCfsOther ? convertFn : null}
      />
    </div>
  );
}

