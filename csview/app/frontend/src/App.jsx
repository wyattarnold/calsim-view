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
const MAX_PANEL_WIDTH = 800;
const DEFAULT_RIGHT_WIDTH = 500;
const DEFAULT_LEFT_WIDTH = 280;

export default function App() {
  const [selectedNode, setSelectedNode] = useState(null);
  const [flyToFeature, setFlyToFeature] = useState(null);
  const [activeStudy, setActiveStudy] = useState(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [graphOpen, setGraphOpen] = useState(true);
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_WIDTH);
  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT_WIDTH);
  // Track which drag handle is active: "left" | "middle" | null
  const dragging = useRef(null);
  const leftWidthRef = useRef(DEFAULT_LEFT_WIDTH);
  const showGraphRef = useRef(false);

  const { data: studiesData } = useQuery({
    queryKey: ["studies"],
    queryFn: fetchStudies,
  });

  const _study = activeStudy ?? studiesData?.active;

  // ---------------------------------------------------------------------------
  // Resize logic
  // ---------------------------------------------------------------------------
  const handleLeftDragStart = useCallback((e) => {
    e.preventDefault();
    dragging.current = "left";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const handleMiddleDragStart = useCallback((e) => {
    e.preventDefault();
    dragging.current = "middle";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const onMove = (e) => {
      if (!dragging.current) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      if (dragging.current === "left") {
        const w = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, clientX));
        setLeftWidth(w);
        leftWidthRef.current = w;
      } else if (dragging.current === "middle") {
        const graphOffset = showGraphRef.current ? leftWidthRef.current + 4 : 0;
        setRightWidth(Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, clientX - graphOffset)));
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
  const showGraph = showPanels && graphOpen;

  showGraphRef.current = showGraph;
  leftWidthRef.current = leftWidth;

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

      {/* Layout: [NeighborhoodGraph] [NodePanel] [Map] */}
      <div className="flex flex-1 overflow-hidden">

        {/* Leftmost panel — neighborhood graph */}
        {showGraph && (
          <>
            <aside
              style={{ width: leftWidth, backgroundColor: "#0a0f1a" }}
              className="flex flex-col border-r border-gray-700 overflow-hidden shrink-0"
            >
              <ErrorBoundary>
                <NeighborhoodGraph
                  featureId={selectedNode}
                  onNodeClick={handleNeighborhoodNodeClick}
                />
              </ErrorBoundary>
            </aside>
            <div
              onMouseDown={handleLeftDragStart}
              onTouchStart={handleLeftDragStart}
              className="w-1 bg-gray-700 hover:bg-blue-500 cursor-col-resize shrink-0 transition-colors"
            />
          </>
        )}

        {/* Node detail panel */}
        {showPanels && (
          <>
            <aside
              style={{ width: rightWidth, backgroundColor: "#1f2937" }}
              className="flex flex-col border-r border-gray-700 overflow-hidden shrink-0"
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
            </aside>
            <div
              onMouseDown={handleMiddleDragStart}
              onTouchStart={handleMiddleDragStart}
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


