/**
 * Small reusable chart sub-components: toggleable legend + tooltip.
 */
import { seriesColor, shortKey } from "./chartUtils.js";

// ---------------------------------------------------------------------------
// Toggleable legend — clicking a pill hides/shows the series
// ---------------------------------------------------------------------------

export function ToggleLegend({ keys, hidden, onToggle, keyLabels = {} }) {
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
// Custom Recharts tooltip
// ---------------------------------------------------------------------------

export function ChartTooltip({ active, payload, label, yUnit = "", keyLabels = {}, excludeKeys = null }) {
  if (!active || !payload?.length) return null;
  const items = payload
    .filter((p) => {
      const dk = String(p.dataKey);
      if (excludeKeys && excludeKeys.has(dk)) return false;
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
          {shortKey(String(item.dataKey), keyLabels)}: {typeof item.value === "number" ? item.value.toFixed(2) : item.value}{yUnit}
        </p>
      ))}
    </div>
  );
}
