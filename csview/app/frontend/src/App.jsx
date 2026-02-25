import { useRef, useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import NetworkMap from "./components/NetworkMap.jsx";
import NodePanel from "./components/NodePanel.jsx";
import NeighborhoodGraph from "./components/NeighborhoodGraph.jsx";
import StudySelector from "./components/StudySelector.jsx";
import NodeSearch from "./components/NodeSearch.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { fetchStudies } from "./api/client.js";

const MIN_PANEL_WIDTH = 260;
const MAX_PANEL_WIDTH = 900;
const DEFAULT_PANEL_WIDTH = 750;
const MIN_GRAPH_PCT  = 0.15;
const MAX_GRAPH_PCT  = 0.70;
const DEFAULT_GRAPH_PCT = 0.33;

export default function App() {
  const [selectedNode, setSelectedNode] = useState(null);
  const [flyToFeature, setFlyToFeature] = useState(null);
  const [activeStudy, setActiveStudy] = useState(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [graphOpen, setGraphOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [graphHeightPct, setGraphHeightPct] = useState(DEFAULT_GRAPH_PCT);

  const dragging = useRef(null);   // "col" | "row" | null
  const panelRef = useRef(null);   // ref to the left stacked panel container

  const { data: studiesData } = useQuery({
    queryKey: ["studies"],
    queryFn: fetchStudies,
  });

  const _study = activeStudy ?? studiesData?.active;

  // ---------------------------------------------------------------------------
  // Resize logic
  // ---------------------------------------------------------------------------
  const handleColDragStart = useCallback((e) => {
    e.preventDefault();
    dragging.current = "col";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const handleRowDragStart = useCallback((e) => {
    e.preventDefault();
    dragging.current = "row";
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      if (dragging.current === "col") {
        setPanelWidth(Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, clientX)));
      } else if (dragging.current === "row" && panelRef.current) {
        const rect = panelRef.current.getBoundingClientRect();
        const pct = (clientY - rect.top) / rect.height;
        // pct is the fraction for NodePanel (top); graph gets (1 - pct)
        const graphPct = 1 - pct;
        setGraphHeightPct(Math.max(MIN_GRAPH_PCT, Math.min(MAX_GRAPH_PCT, graphPct)));
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
  }, []);

  // ---------------------------------------------------------------------------
  // Feature selection
  // ---------------------------------------------------------------------------
  function handleFeatureClick(featureId) {
    setSelectedNode(featureId);
    setPanelOpen(true);
  }

  function handleNeighborhoodNodeClick(featureId) {
    setSelectedNode(featureId);
    setPanelOpen(true);
    setFlyToFeature(featureId);
  }

  function handlePanelClose() {
    setPanelOpen(false);
    setSelectedNode(null);
  }

  const showPanels = panelOpen && !!selectedNode;
  const showGraph  = showPanels && graphOpen;

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
        <div className="flex-1" />
      </header>

      {/* Layout: [Left stacked panel] [drag] [Map] */}
      <div className="flex flex-1 overflow-hidden">

        {/* Single left panel — NodePanel (top) + NeighborhoodGraph (bottom) */}
        {showPanels && (
          <>
            <aside
              ref={panelRef}
              style={{ width: panelWidth }}
              className="flex flex-col border-r border-gray-700 overflow-hidden shrink-0"
            >
              {/* Results panel — top portion */}
              <div
                style={{ height: showGraph ? `${(1 - graphHeightPct) * 100}%` : "100%" }}
                className="flex flex-col overflow-hidden bg-gray-800"
              >
                <ErrorBoundary>
                  <NodePanel
                    featureId={selectedNode}
                    activeStudy={_study}
                    onClose={handlePanelClose}
                    graphOpen={graphOpen}
                    onToggleGraph={() => setGraphOpen((g) => !g)}
                  />
                </ErrorBoundary>
              </div>

              {/* Vertical drag handle + Network graph — bottom portion */}
              {showGraph && (
                <>
                  <div
                    onMouseDown={handleRowDragStart}
                    onTouchStart={handleRowDragStart}
                    className="h-1 bg-gray-700 hover:bg-blue-500 cursor-row-resize shrink-0 transition-colors"
                  />
                  <div
                    style={{ height: `${graphHeightPct * 100}%` }}
                    className="flex flex-col overflow-hidden bg-gray-950"
                  >
                    <ErrorBoundary>
                      <NeighborhoodGraph
                        featureId={selectedNode}
                        onNodeClick={handleNeighborhoodNodeClick}
                      />
                    </ErrorBoundary>
                  </div>
                </>
              )}
            </aside>

            {/* Horizontal drag handle */}
            <div
              onMouseDown={handleColDragStart}
              onTouchStart={handleColDragStart}
              className="w-1 bg-gray-700 hover:bg-blue-500 cursor-col-resize shrink-0 transition-colors"
            />
          </>
        )}

        {/* Map — fills remaining space */}
        <div className="flex-1 relative overflow-hidden">
          <NetworkMap
            selectedFeature={selectedNode}
            flyToFeature={flyToFeature}
            onFeatureClick={handleFeatureClick}
          />
        </div>
      </div>
    </div>
  );
}