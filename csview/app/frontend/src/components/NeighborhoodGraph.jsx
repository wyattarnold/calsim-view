import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchNeighborhood } from "../api/client.js";

// ---------------------------------------------------------------------------
// Color table — must match NetworkMap.jsx NODE_STYLE
// ---------------------------------------------------------------------------

const NODE_COLOR = {
  "Reservoir":            "#3b82f6",
  "Groundwater":          "#10b981",
  "Groundwater Storage":  "#059669",
  "Demand-Agricultural":  "#f59e0b",
  "Demand-Urban":         "#f97316",
  "Demand-Refuge":        "#84cc16",
  "Shortage":             "#ef4444",
  "Contract":             "#eab308",
  "Return Flow":          "#a3e635",
  "Water Quality":        "#22d3ee",
  "Power":                "#a855f7",
  "Channel":              "#60a5fa",
  "Diversion":            "#34d399",
  "Inflow":               "#2dd4bf",
  "Minimum Flow":         "#38bdf8",
};

const DEFAULT_NODE_COLOR = "#6b7280";

// ---------------------------------------------------------------------------
// Layout — upstream (negative dist) at top, downstream at bottom
// ---------------------------------------------------------------------------

const NODE_R = 9;
const NODE_SPACING_X = 82;
const ROW_HEIGHT = 88;
const PAD_X = 50;
const PAD_Y = 28;
const LABEL_OFFSET = 13;

function computeLayout(nodes) {
  if (!nodes || nodes.length === 0) return { positions: {}, svgW: 120, svgH: 100 };

  const byRow = new Map();
  for (const n of nodes) {
    if (!byRow.has(n.distance)) byRow.set(n.distance, []);
    byRow.get(n.distance).push(n);
  }

  const rows = Array.from(byRow.keys()).sort((a, b) => a - b);
  const maxInRow = Math.max(1, ...Array.from(byRow.values()).map((g) => g.length));

  const svgW = Math.max(PAD_X * 2 + (maxInRow - 1) * NODE_SPACING_X, 120);
  const svgH = PAD_Y + (rows.length - 1) * ROW_HEIGHT + NODE_R + LABEL_OFFSET + 14 + PAD_Y;

  const positions = {};
  rows.forEach((row, rowIdx) => {
    const group = byRow.get(row);
    const y = PAD_Y + NODE_R + rowIdx * ROW_HEIGHT;
    const totalW = (group.length - 1) * NODE_SPACING_X;
    const startX = svgW / 2 - totalW / 2;
    group.forEach((n, colIdx) => {
      positions[n.feature_id] = { x: startX + colIdx * NODE_SPACING_X, y };
    });
  });

  return { positions, svgW, svgH: Math.max(svgH, 100) };
}

function arrowPath(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return null;
  const ux = dx / len;
  const uy = dy / len;
  const sx = x1 + ux * (NODE_R + 1);
  const sy = y1 + uy * (NODE_R + 1);
  const ex = x2 - ux * (NODE_R + 7);
  const ey = y2 - uy * (NODE_R + 7);
  return `M ${sx} ${sy} L ${ex} ${ey}`;
}

const MAX_NODES_WARNING = 80;

export default function NeighborhoodGraph({ featureId, onNodeClick }) {
  const [depth, setDepth] = useState(2);

  const { data, isLoading } = useQuery({
    queryKey: ["neighborhood", featureId, depth],
    queryFn: () => fetchNeighborhood(featureId, depth),
    enabled: !!featureId,
  });

  const layout = useMemo(() => {
    if (!data) return null;
    return computeLayout(data.nodes);
  }, [data]);

  if (!featureId) return null;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-700 shrink-0">
        <span className="text-xs text-gray-400 font-semibold uppercase tracking-wider">
          Network Graph
        </span>
        <div className="flex gap-1 ml-2">
          {[1, 2, 3].map((d) => (
            <button
              key={d}
              onClick={() => setDepth(d)}
              className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                depth === d
                  ? "bg-blue-700 border-blue-500 text-white"
                  : "border-gray-600 text-gray-400 hover:border-gray-400 hover:text-gray-200"
              }`}
            >
              ±{d}
            </button>
          ))}
        </div>
        {data && (
          <span className="ml-auto text-[10px] text-gray-500 tabular-nums">
            {data.nodes.length}n · {data.arcs.length}e
          </span>
        )}
      </div>

      {/* Graph area */}
      <div className="flex-1 overflow-auto bg-gray-950">
        {isLoading && <p className="text-gray-500 text-sm p-4">Loading…</p>}

        {data && data.nodes.length > MAX_NODES_WARNING && (
          <p className="text-yellow-500 text-xs px-3 py-1 shrink-0">
            Large neighborhood ({data.nodes.length} nodes). Try ±1 or ±2.
          </p>
        )}

        {data && data.nodes && data.arcs && layout && (
          <svg
            width={layout.svgW}
            height={layout.svgH}
            className="block"
            style={{ minWidth: "100%", minHeight: "100%" }}
          >
            <defs>
              <marker id="nbh-arr" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <polygon points="0 0, 7 3.5, 0 7" fill="#4b5563" />
              </marker>
              <marker id="nbh-arr-sel" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <polygon points="0 0, 7 3.5, 0 7" fill="#facc15" />
              </marker>
            </defs>

            {/* Distance-level row labels */}
            {Array.from(new Map(data.nodes.map((n) => [n.distance, n.distance])).values())
              .sort((a, b) => a - b)
              .map((dist, rowIdx) => {
                const label =
                  dist < 0 ? `up ${Math.abs(dist)}` : dist > 0 ? `dn ${dist}` : "focus";
                const y = PAD_Y + NODE_R + rowIdx * ROW_HEIGHT;
                return (
                  <text
                    key={dist}
                    x={6}
                    y={y}
                    fontSize={8}
                    fill={dist === 0 ? "#6b7280" : "#374151"}
                    dominantBaseline="middle"
                    fontStyle={dist === 0 ? "normal" : "italic"}
                  >
                    {label}
                  </text>
                );
              })}

            {/* Arcs */}
            {data.arcs.map((arc) => {
              const from = layout.positions[arc.from_node?.toUpperCase()];
              const to = layout.positions[arc.to_node?.toUpperCase()];
              if (!from || !to) return null;
              const isTouchingFocus = arc.from_node === featureId || arc.to_node === featureId;
              const d = arrowPath(from.x, from.y, to.x, to.y);
              if (!d) return null;
              return (
                <path
                  key={arc.feature_id}
                  d={d}
                  fill="none"
                  stroke={isTouchingFocus ? "#facc15" : "#374151"}
                  strokeWidth={isTouchingFocus ? 1.5 : 1}
                  opacity={isTouchingFocus ? 0.9 : 0.55}
                  markerEnd={isTouchingFocus ? "url(#nbh-arr-sel)" : "url(#nbh-arr)"}
                />
              );
            })}

            {/* Nodes */}
            {data.nodes.map((n) => {
              const pos = layout.positions[n.feature_id];
              if (!pos) return null;
              const isFocus = n.feature_id === featureId;
              const color = NODE_COLOR[n.node_type] || DEFAULT_NODE_COLOR;
              const label = n.feature_id.length > 14 ? n.feature_id.slice(0, 13) + "…" : n.feature_id;

              return (
                <g
                  key={n.feature_id}
                  transform={`translate(${pos.x}, ${pos.y})`}
                  onClick={() => onNodeClick(n.feature_id)}
                  className="cursor-pointer"
                >
                  <title>{`${n.feature_id}${n.description ? "\n" + n.description : ""}\n${n.node_type ?? ""}`}</title>
                  {isFocus && (
                    <circle r={NODE_R + 4} fill="none" stroke="#ffffff" strokeWidth={1.5} opacity={0.4} />
                  )}
                  <circle
                    r={NODE_R}
                    fill={color}
                    stroke={isFocus ? "#ffffff" : "#0f172a"}
                    strokeWidth={isFocus ? 2 : 0.8}
                    opacity={0.93}
                  />
                  <text
                    y={NODE_R + LABEL_OFFSET}
                    textAnchor="middle"
                    fontSize={9}
                    fill={isFocus ? "#e5e7eb" : "#9ca3af"}
                    fontWeight={isFocus ? "600" : "400"}
                  >
                    {label}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
