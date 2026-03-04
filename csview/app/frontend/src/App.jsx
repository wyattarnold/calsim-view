import { useRef, useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import NetworkMap from "./components/NetworkMap.jsx";
import NodePanel from "./components/NodePanel.jsx";
import NeighborhoodGraph from "./components/NeighborhoodGraph.jsx";
import StudySelector from "./components/StudySelector.jsx";
import NodeSearch from "./components/NodeSearch.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { fetchStudies } from "./api/client.js";

const MIN_PANEL_WIDTH = 220;
const MAX_PANEL_WIDTH = 900;
const DEFAULT_PANEL_WIDTH = 460;
const DEFAULT_GRAPH_WIDTH = 300;

export default function App() {
  const [selectedNode, setSelectedNode] = useState(null);
  const [selectedWba, setSelectedWba] = useState(null);
  const [flyToFeature, setFlyToFeature] = useState(null);
  const [activeStudy, setActiveStudy] = useState(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [graphOpen, setGraphOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [graphWidth, setGraphWidth] = useState(DEFAULT_GRAPH_WIDTH);
  const [comparisonMode, setComparisonMode] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  const dragging = useRef(null);   // "panel" | "graph" | null

  const { data: studiesData } = useQuery({
    queryKey: ["studies"],
    queryFn: fetchStudies,
  });

  const _study = activeStudy ?? studiesData?.active;

  // ---------------------------------------------------------------------------
  // Resize logic — two independent column drag handles
  // ---------------------------------------------------------------------------

  const handlePanelDragStart = useCallback((e) => {
    e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    dragging.current = { type: "panel", startX: clientX, startWidth: panelWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [panelWidth]);

  const handleGraphDragStart = useCallback((e) => {
    e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    dragging.current = { type: "graph", startX: clientX, startWidth: graphWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [graphWidth]);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const { type, startX, startWidth } = dragging.current;
      const newW = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, startWidth + (clientX - startX)));
      if (type === "graph") setGraphWidth(newW);
      else if (type === "panel") setPanelWidth(newW);
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove);
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Feature selection
  // ---------------------------------------------------------------------------
  function handleFeatureClick(featureId) {
    setSelectedNode(featureId);
    setSelectedWba(null);
    setPanelOpen(true);
  }

  function handleWbaClick(wbaId) {
    setSelectedWba(wbaId);
    // Don't clear selectedNode — keeps the neighbourhood graph visible
    // so the layout doesn't jump when switching to a WBA.
    setPanelOpen(true);
  }

  function handleNeighborhoodNodeClick(featureId) {
    setSelectedNode(featureId);
    setSelectedWba(null);
    setPanelOpen(true);
    setFlyToFeature(featureId);
  }

  function handleEdgeClick(featureId) {
    setSelectedNode(featureId);
    setSelectedWba(null);
    setPanelOpen(true);
    setFlyToFeature(featureId);
  }

  function handlePanelClose() {
    setPanelOpen(false);
    setSelectedNode(null);
    setSelectedWba(null);
  }

  const showPanel = panelOpen && (!!selectedNode || !!selectedWba);
  const showGraph = showPanel && graphOpen && !!selectedNode;

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-gray-100 overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-2 bg-gray-800 border-b border-gray-700 shrink-0 z-10">
        <h1 className="text-lg font-semibold text-blue-400 whitespace-nowrap">CalSim 3</h1>
        <NodeSearch onSelect={handleNeighborhoodNodeClick} />
        <StudySelector
          studies={studiesData?.studies ?? []}
          active={_study}
          onChange={setActiveStudy}
        />
        {/* Network graph toggle — visible whenever a feature is selected */}
        {showPanel && (
          <button
            onClick={() => setGraphOpen((g) => !g)}
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border transition-colors ${
              graphOpen
                ? "border-blue-500 text-blue-400 bg-blue-950"
                : "border-gray-600 text-gray-400 hover:border-blue-400 hover:text-blue-400"
            }`}
            title={graphOpen ? "Hide network graph" : "Show network graph"}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <circle cx="4" cy="4" r="1.5" /><circle cx="12" cy="4" r="1.5" /><circle cx="8" cy="12" r="1.5" />
              <line x1="4" y1="5.5" x2="8" y2="10.5" stroke="currentColor" strokeWidth="1" />
              <line x1="12" y1="5.5" x2="8" y2="10.5" stroke="currentColor" strokeWidth="1" />
            </svg>
            Graph
          </button>
        )}
        {/* Comparison mode toggle — always visible */}
        <button
          onClick={() => setComparisonMode((m) => !m)}
          className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border transition-colors ${
            comparisonMode
              ? "border-orange-500 text-orange-400 bg-orange-950"
              : "border-gray-600 text-gray-400 hover:border-orange-400 hover:text-orange-400"
          }`}
          title={comparisonMode ? "Exit comparison mode" : "Compare studies side-by-side"}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3.5 h-3.5">
            <line x1="4" y1="2" x2="4" y2="14" />
            <line x1="12" y1="2" x2="12" y2="14" />
            <polyline points="1,5 4,2 7,5" />
            <polyline points="9,11 12,14 15,11" />
          </svg>
          Compare
        </button>
        <div className="flex-1" />
        {/* Info button */}
        <button
          onClick={() => setShowInfo(true)}
          className="flex items-center justify-center w-7 h-7 rounded-full border border-gray-600 text-gray-400 hover:border-blue-400 hover:text-blue-400 transition-colors text-sm font-semibold shrink-0"
          title="About CalSim View"
          aria-label="About"
        >
          i
        </button>
      </header>

      {/* Info modal */}
      {showInfo && (
        <div
          className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/75 backdrop-blur-sm"
          onClick={() => setShowInfo(false)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-md mx-4 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <h2 className="text-lg font-semibold text-blue-400">CalSim View</h2>
              <button
                onClick={() => setShowInfo(false)}
                className="text-gray-500 hover:text-gray-200 text-xl leading-none ml-4"
                aria-label="Close"
              >
                &times;
              </button>
            </div>
            <p className="text-sm text-gray-300 leading-relaxed mb-5">
              CalSim View is an interactive viewer for CalSim 3 model results.
              It lets you explore the water-resources network schematic, inspect
              time-series results for arcs and nodes, review groundwater budget
              summaries by region, and compare outcomes across multiple model
              studies side-by-side.
            </p>
            <div className="space-y-3">
              <a
                href="https://github.com/wyattarnold/calsim-view"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 text-sm text-blue-400 hover:text-blue-300 transition-colors group"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 shrink-0">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
                    0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13
                    -.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66
                    .07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15
                    -.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0
                    1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82
                    1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01
                    1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
                  />
                </svg>
                <span className="group-hover:underline">GitHub repository</span>
              </a>
              <a
                href="https://github.com/wyattarnold/calsim-view/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 text-sm text-amber-400 hover:text-amber-300 transition-colors group"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4 shrink-0">
                  <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8
                    8 0 0 1 0 8zm9 3a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm-.25-6.25a.75.75 0 0
                    0-1.5 0v3.5a.75.75 0 0 0 1.5 0v-3.5z"
                  />
                </svg>
                <span className="group-hover:underline">Submit an issue</span>
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Layout: [Graph] [drag] [NodePanel] [drag] [Map] */}
      <div className="flex flex-1 overflow-hidden">

        {/* Far-left: Network Graph panel */}
        {showGraph && (
          <>
            <aside
              style={{ width: graphWidth }}
              className="flex flex-col border-r border-gray-700 overflow-hidden shrink-0 bg-gray-950"
            >
              <ErrorBoundary>
                <NeighborhoodGraph
                  featureId={selectedNode}
                  onNodeClick={handleNeighborhoodNodeClick}
                  onEdgeClick={handleEdgeClick}
                  onClose={() => setGraphOpen(false)}
                />
              </ErrorBoundary>
            </aside>

            {/* Graph ↔ Panel drag handle */}
            <div
              onMouseDown={handleGraphDragStart}
              onTouchStart={handleGraphDragStart}
              className="w-1 bg-gray-700 hover:bg-blue-500 cursor-col-resize shrink-0 transition-colors"
            />
          </>
        )}

        {/* Middle: NodePanel or GwBudgetPanel */}
        {showPanel && (
          <>
            <aside
              style={{ width: panelWidth }}
              className="flex flex-col border-r border-gray-700 overflow-hidden shrink-0 bg-gray-800"
            >
              <ErrorBoundary>
                <NodePanel
                  featureId={selectedNode}
                  wbaId={selectedWba}
                  activeStudy={_study}
                  comparisonMode={comparisonMode}
                  allStudies={studiesData?.studies ?? []}
                  onClose={handlePanelClose}
                />
              </ErrorBoundary>
            </aside>

            {/* Panel ↔ Map drag handle */}
            <div
              onMouseDown={handlePanelDragStart}
              onTouchStart={handlePanelDragStart}
              className="w-1 bg-gray-700 hover:bg-blue-500 cursor-col-resize shrink-0 transition-colors"
            />
          </>
        )}

        {/* Right: Map — fills remaining space */}
        <div className="flex-1 relative overflow-hidden">
          <NetworkMap
            selectedFeature={selectedNode}
            flyToFeature={flyToFeature}
            onFeatureClick={handleFeatureClick}
            onWbaClick={handleWbaClick}
          />
        </div>
      </div>
    </div>
  );
}
