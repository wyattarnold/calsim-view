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
    dragging.current = "panel";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const handleGraphDragStart = useCallback((e) => {
    e.preventDefault();
    dragging.current = "graph";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      if (dragging.current === "graph") {
        // Graph panel is far-left; its right edge tracks the mouse
        setGraphWidth(Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, clientX)));
      } else if (dragging.current === "panel") {
        // NodePanel right edge.  Its left edge = graphWidth + 4 (drag handle).
        const leftEdge = graphOpen ? graphWidth + 4 : 0;
        const newW = clientX - leftEdge;
        setPanelWidth(Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, newW)));
      }
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
  }, [graphOpen, graphWidth]);

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
        <div className="flex-1" />
      </header>

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
