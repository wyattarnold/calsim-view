import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchFeatures } from "../api/client.js";

export default function NodeSearch({ onSelect }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  const { data: features = [] } = useQuery({
    queryKey: ["features"],
    queryFn: fetchFeatures,
  });

  const q = query.trim().toLowerCase();
  const results = q.length === 0 ? [] : features
    .filter((f) =>
      f.feature_id.toLowerCase().includes(q) ||
      (f.description || "").toLowerCase().includes(q) ||
      (f.name || "").toLowerCase().includes(q) ||
      (f.hydro_region || "").toLowerCase().includes(q)
    )
    .slice(0, 12);

  // Close dropdown on outside click
  useEffect(() => {
    function onMouseDown(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  function handleSelect(featureId) {
    setQuery("");
    setOpen(false);
    onSelect(featureId);
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        placeholder="Search features…"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => { if (query.trim()) setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setOpen(false); setQuery(""); inputRef.current?.blur(); }
          if (e.key === "Enter" && results.length === 1) handleSelect(results[0].feature_id);
        }}
        className="w-48 text-xs bg-gray-700 border border-gray-600 rounded px-2.5 py-1 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
      />
      {open && results.length > 0 && (
        <div className="absolute top-full left-0 mt-1 w-72 bg-gray-800 border border-gray-700 rounded shadow-xl z-[2000] max-h-72 overflow-y-auto">
          {results.map((f) => (
            <button
              key={f.feature_id}
              onMouseDown={(e) => { e.preventDefault(); handleSelect(f.feature_id); }}
              className="flex flex-col w-full text-left px-3 py-2 hover:bg-gray-700 border-b border-gray-700 last:border-0"
            >
              <span className="font-mono text-xs text-blue-400">{f.feature_id}</span>
              {(f.description || f.name) && (
                <span className="text-[10px] text-gray-400 truncate">
                  {f.description || f.name}
                </span>
              )}
              <div className="flex gap-2 mt-0.5">
                {(f.node_type || f.arc_type) && (
                  <span className="text-[10px] text-gray-600">{f.node_type || f.arc_type}</span>
                )}
                {f.hydro_region && (
                  <span className="text-[10px] text-gray-700">· {f.hydro_region}</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
