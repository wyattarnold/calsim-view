import { useState, useRef } from "react";

// ---------------------------------------------------------------------------
// Drought presets (configurable)
// ---------------------------------------------------------------------------

const DROUGHT_PRESETS = [
  { label: "1928–37", start: "1928", end: "1937" },
  { label: "1976–77", start: "1976", end: "1977" },
  { label: "1987–92", start: "1987", end: "1992" },
];

// ---------------------------------------------------------------------------
// YearRangeSlider — dual-thumb range with preset pills and pan
// ---------------------------------------------------------------------------

export default function YearRangeSlider({ years, startIdx, endIdx, onStartChange, onEndChange }) {
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

  function handleCenterPointerUp() {
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
          <span>WY {years[startIdx]}</span>
          <span>WY {years[endIdx]}</span>
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
