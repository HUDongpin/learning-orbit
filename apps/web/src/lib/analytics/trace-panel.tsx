"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SnaProjectionBundle } from "@learning-orbit/contracts";
import type { ProjectionSlot } from "../session/projection-sync";
import { DEFAULT_ROOM_VIEW, type RoomViewPreferences } from "../session/room-route";
import { identityInitial, identityStyle } from "../chat/identity";
import { AnalysisWarnings } from "./analysis-warnings";
import { ProjectionPanelState } from "./projection-panel-state";
import {
  allocateScreenEdges,
  fitNodesForPortCapacity,
  type AllocatedEdge,
  type ScreenMatrix,
  type SnaLayoutNode,
} from "../sna/port-allocator";
import {
  interpretationMatchesClaimCeiling,
  METRIC_EXPLANATION,
  TRACE_STUDENT_INTERPRETATION_ZH_HANT,
  traceLayerLabel,
  traceNodeKindLabel,
} from "./display-labels";

const WINDOWS = ["recent_10m", "session_45m"] as const;
const VIEWS = ["observed", "human_only", "lineage_adjusted"] as const;
type WindowName = typeof WINDOWS[number];
type ViewName = typeof VIEWS[number];
type TraceBundle = SnaProjectionBundle;

const WINDOW_COPY: Record<WindowName, string> = { recent_10m: "最近 10 分鐘", session_45m: "全課 45 分鐘" };
const VIEW_COPY: Record<ViewName, string> = { observed: "觀察網絡", human_only: "僅人類", lineage_adjusted: "承接關係" };
const METRICS = [
  ["participationBalance", "群體參與平衡"],
  ["reciprocity", "群體互惠"],
  ["agentShare", "Agent 事件比例"],
  ["semanticCoverage", "群體語意涵蓋"],
] as const;
const percent = new Intl.NumberFormat("zh-Hant", { style: "percent", maximumFractionDigits: 0 });

/** Legend swatch colour per node kind; a learner keeps its own seat hue. */
const KIND_SWATCH: Readonly<Record<string, string>> = {
  agent: "var(--who-nova)",
  room: "var(--accent-amber)",
};

/*
 * A server token and its plain-language reading, together. The token stays on
 * screen because it is what the server actually said; the reading is what a
 * 13-year-old can act on. When `display-labels` has no entry for a token it
 * returns the token unchanged, and printing it twice would be noise — so it is
 * printed once.
 */

/** Reading first: the list is read by students. */
function layerReadingFirst(token: string): string {
  const label = traceLayerLabel(token);
  return label === token ? token : `${label}（${token}）`;
}

/** Token first: the Inspector line is pinned as `互動層：<token>`. */
function layerTokenFirst(token: string): string {
  const label = traceLayerLabel(token);
  return label === token ? token : `${token}（${label}）`;
}

/* ---------------------------------------------------------------------------
   Canvas measurement.

   A fixed viewBox scales every label down with the panel: on a phone the 15px
   pseudonym rendered at roughly 7 CSS px. Building the viewBox from the
   measured wrapper box makes one SVG unit one CSS pixel at every width, so the
   type sizes authored in globals.css are the sizes a student actually reads.
   ------------------------------------------------------------------------ */
type Canvas = Readonly<{ width: number; height: number }>;
const CANVAS_FALLBACK: Canvas = { width: 960, height: 420 };

const IDENTITY_MATRIX: ScreenMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/**
 * The transform between the SVG's own coordinates and the screen.
 *
 * It is read from the element rather than assumed to be the identity, because
 * it is not: application zoom, a stylesheet that sizes the SVG differently
 * from its viewBox, and the frames between a resize and the observer firing
 * all change it. Those are exactly the moments when two arrows quietly
 * converge, so the separation has to be computed in this frame, not in the
 * viewBox's.
 */
function useScreenMatrix(canvas: Canvas): readonly [(element: SVGSVGElement | null) => void, ScreenMatrix] {
  const [matrix, setMatrix] = useState<ScreenMatrix>(IDENTITY_MATRIX);
  const element = useRef<SVGSVGElement | null>(null);
  const read = useCallback(() => {
    const svg = element.current;
    // jsdom has no getScreenCTM; the identity keeps the graph deterministic
    // there, which is also what the viewBox produces in a real browser at
    // 100% zoom.
    const ctm = svg && typeof svg.getScreenCTM === "function" ? svg.getScreenCTM() : null;
    if (!ctm || !Number.isFinite(ctm.a) || ctm.a === 0) return;
    setMatrix((current) => (current.a === ctm.a && current.d === ctm.d
      && current.b === ctm.b && current.c === ctm.c ? current
      : { a: ctm.a, b: ctm.b, c: ctm.c, d: ctm.d, e: 0, f: 0 }));
  }, []);
  const attach = useCallback((next: SVGSVGElement | null) => {
    element.current = next;
    read();
  }, [read]);
  // The canvas changing means the box changed, which is when the transform
  // most often changes with it.
  useEffect(read, [read, canvas.width, canvas.height]);
  return [attach, matrix] as const;
}

function useMeasuredCanvas(): readonly [(element: HTMLDivElement | null) => void, Canvas] {
  const [canvas, setCanvas] = useState<Canvas>(CANVAS_FALLBACK);
  const observer = useRef<ResizeObserver | undefined>(undefined);
  const attach = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = undefined;
    // jsdom has no ResizeObserver; the fallback box keeps the graph deterministic.
    if (!element || typeof ResizeObserver === "undefined") return;
    const next = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      const width = Math.max(280, Math.round(box.width));
      const height = Math.min(560, Math.max(260, Math.round(box.height)));
      setCanvas((current) => current.width === width && current.height === height
        ? current
        : { width, height });
    });
    next.observe(element);
    observer.current = next;
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [attach, canvas] as const;
}

/* ---------------------------------------------------------------------------
   Port-fan geometry.

   Centre-to-centre straight lines collapse every relation between the same two
   people into a single stroke, so a pair that replied four times looked
   identical to a pair that replied once, and a reply looked identical to an
   uptake. Each incident relation now gets its own port on the node rim, and
   parallel relations bow apart, so the count and the direction survive.
   ------------------------------------------------------------------------ */
const NODE_R = 30;
const MARGIN_X = 74;
const MARGIN_Y = 64;

type AdaptedNode = { key: string; label: string; kind: string; x: number; y: number };
type GraphNode = SnaLayoutNode & { label: string; kind: string };
type AdaptedEdge = {
  key: string;
  sourceKey: string;
  targetKey: string;
  sourceLabel: string;
  targetLabel: string;
  layer: string;
  weight?: number;
  evidenceCount?: number;
};

function adapt(bundle: TraceBundle, windowName: WindowName, viewName: ViewName, canvas: Canvas) {
  const window = bundle.payload.windows[windowName];
  const view = window.views[viewName];
  const sorted = [...view.nodes].sort((left, right) => left.label.localeCompare(right.label, "zh-Hant"));
  const centreX = canvas.width / 2;
  const centreY = canvas.height / 2;
  const radiusX = Math.max(NODE_R, centreX - MARGIN_X);
  const radiusY = Math.max(NODE_R, centreY - MARGIN_Y);
  const nodes: AdaptedNode[] = sorted.map((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, sorted.length) - Math.PI / 2;
    return {
      key: node.nodeId,
      label: node.label,
      kind: node.kind,
      x: centreX + Math.cos(angle) * radiusX,
      y: centreY + Math.sin(angle) * radiusY,
    };
  });
  const label = new Map(nodes.map((node) => [node.key, node.label]));

  const rawEdges = view.edges.map((edge, index) => {
    const sourceKey = "sourceNodeId" in edge ? edge.sourceNodeId : edge.sourceId;
    const targetKey = "targetNodeId" in edge ? edge.targetNodeId : edge.targetId;
    return {
      key: "edgeId" in edge ? edge.edgeId : `${sourceKey}\0${targetKey}\0${edge.layer}\0${index}`,
      sourceKey,
      targetKey,
      layer: edge.layer as string,
      ...("weight" in edge ? { weight: edge.weight } : {}),
      ...("evidenceRefs" in edge && Array.isArray(edge.evidenceRefs) ? { evidenceCount: edge.evidenceRefs.length } : {}),
    };
  });

  // Port fanning, pair ranking and bow offsets used to be counted here by
  // hand, in layout units. The screen-pixel allocator owns all of it now,
  // because the guarantee has to hold in the frame the reader is looking at.
  const edges: AdaptedEdge[] = rawEdges.map((edge) => {
    return {
      ...edge,
      sourceLabel: label.get(edge.sourceKey) ?? "未命名節點",
      targetLabel: label.get(edge.targetKey) ?? "未命名節點",
    };
  });
  return { window, view, nodes, edges, centreX, centreY };
}

/** Quadratic path plus the point where its predicate badge belongs. */

/**
 * The window and view a viewer chose live in the URL, not in this component.
 * A reload, a restored tab or a link pasted to a colleague must land on the
 * same view, and this product may not put anything in browser storage.
 */
export function TracePanel({ slot, onRetry, preferences, onPreferencesChange }: Readonly<{
  slot: ProjectionSlot;
  onRetry: () => void;
  preferences?: RoomViewPreferences;
  onPreferencesChange?: (next: RoomViewPreferences) => void;
}>) {
  const canonical = slot.snapshot && (slot.snapshot.projectionKey === "trace.student_bundle" || slot.snapshot.projectionKey === "trace.teacher_bundle")
    ? slot.snapshot as TraceBundle : undefined;
  const [storedPresented, setPresented] = useState<TraceBundle | undefined>(() => canonical);
  const [paused, setPaused] = useState(false);
  // Fall back to local state only when no URL owner is supplied, so the panel
  // stays usable in isolation (and in its own unit tests).
  const [localPreferences, setLocalPreferences] = useState<RoomViewPreferences>(DEFAULT_ROOM_VIEW);
  const current = preferences ?? localPreferences;
  const update = onPreferencesChange ?? setLocalPreferences;
  const windowName = current.window as WindowName;
  const viewName = current.view as ViewName;
  const setWindowName = (next: WindowName) => update({ ...current, window: next });
  const setViewName = (next: ViewName) => update({ ...current, view: next });
  const [selectedKey, setSelectedKey] = useState<string>();
  const [graphRef, canvas] = useMeasuredCanvas();
  const [svgRef, screenMatrix] = useScreenMatrix(canvas);
  const markerId = `trace-arrow-${useId().replace(/[^a-zA-Z0-9_-]/gu, "")}`;

  useEffect(() => {
    if (!canonical) { setPresented(undefined); return; }
    if (!paused || storedPresented?.projectionKey !== canonical.projectionKey) {
      setPresented(canonical);
      if (paused) setPaused(false);
      setSelectedKey(undefined);
    }
  }, [canonical, paused, storedPresented?.projectionKey]);

  const sameProjection = Boolean(canonical && storedPresented
    && canonical.projectionKey === storedPresented.projectionKey);
  const presented = paused && sameProjection ? storedPresented : canonical;
  const presentationPaused = paused && sameProjection;

  const adapted = useMemo(
    () => presented ? adapt(presented, windowName, viewName, canvas) : undefined,
    [presented, viewName, windowName, canvas],
  );
  /**
   * Ports, fans and paths, decided in final screen pixels.
   *
   * `fitNodesForPortCapacity` runs first because a node that cannot hold its
   * relations must grow rather than have its ports clamped on top of one
   * another: a clamped port draws two interactions as one, which is the exact
   * mistake this panel exists to stop making. The fitted radii are what the
   * circles render at, so the ring the reader sees is the ring the ports were
   * placed on.
   */
  const geometry = useMemo(() => {
    if (!adapted) return { nodes: [] as GraphNode[], edges: [] as AllocatedEdge[] };
    const layout: GraphNode[] = adapted.nodes.map((node) => ({
      nodeId: node.key, x: node.x, y: node.y, rx: NODE_R, ry: NODE_R,
      label: node.label, kind: node.kind,
    }));
    const inputs = adapted.edges.map((edge) => ({
      edgeId: edge.key, source: edge.sourceKey, target: edge.targetKey,
    }));
    if (inputs.length === 0) return { nodes: layout, edges: [] as AllocatedEdge[] };
    try {
      const fitted = fitNodesForPortCapacity(layout, inputs, screenMatrix);
      const byId = new Map(layout.map((node) => [node.nodeId, node]));
      const nodes = fitted.nodes.map((node) => ({ ...byId.get(node.nodeId)!, ...node }));
      return { nodes, edges: allocateScreenEdges(fitted.nodes, inputs, screenMatrix) };
    } catch {
      // A graph this dense has no honest drawing at this size. The equivalent
      // list below carries every relation, so the reader loses the picture and
      // not the information.
      return { nodes: layout, edges: [] as AllocatedEdge[] };
    }
  }, [adapted, screenMatrix]);
  const selectedNode = adapted?.nodes.find(({ key }) => key === selectedKey);
  const selectedEdge = adapted?.edges.find(({ key }) => key === selectedKey);
  const pending = canonical && presented && (canonical.analysisEpoch !== presented.analysisEpoch
    ? 1 : Math.max(0, canonical.projectionVersion - presented.projectionVersion));
  const hasNetwork = Boolean(adapted && (adapted.nodes.length > 0 || adapted.edges.length > 0));
  const kinds = [...new Set(adapted?.nodes.map(({ kind }) => kind) ?? [])];
  const layerCounts = new Map<string, number>();
  for (const edge of adapted?.edges ?? []) layerCounts.set(edge.layer, (layerCounts.get(edge.layer) ?? 0) + 1);

  return <section className="orbit-panel analysis-panel server-analysis-panel" aria-labelledby="trace-panel-title">
    <header className="panel-head">
      <div><span className="panel-kicker">TRACE-AI</span><h2 className="panel-title" id="trace-panel-title">互動網絡</h2></div>
      {presented ? <span className="analysis-version">v{presented.projectionVersion}</span> : null}
    </header>
    <ProjectionPanelState slot={slot} onRetry={onRetry} panelName="TRACE-AI" retryLabel="重新檢查 TRACE 權限">
      {!presented ? <div className="analysis-state analysis-state-error" role="alert">TRACE Projection 類型與角色不一致。</div>
        : <div className="analysis-content">
          <div className="analysis-controls">
            <div className="analysis-switcher" role="group" aria-label="時間窗口">
              {WINDOWS.map((name) => <button key={name} aria-pressed={windowName === name} type="button" onClick={() => { setWindowName(name); setSelectedKey(undefined); }}>{WINDOW_COPY[name]}</button>)}
            </div>
            <div className="analysis-switcher" role="group" aria-label="網絡視圖">
              {VIEWS.map((name) => <button key={name} aria-pressed={viewName === name} type="button" onClick={() => { setViewName(name); setSelectedKey(undefined); }}>{VIEW_COPY[name]}</button>)}
            </div>
            <button className="analysis-pause" type="button" onClick={() => {
              if (presentationPaused) { setPresented(canonical); setPaused(false); }
              else setPaused(true);
            }}>{presentationPaused ? "顯示最新已驗證版本" : "暫停圖譜呈現"}</button>
          </div>
          {presentationPaused && pending ? <p className="analysis-pending" role="status">背景已驗證 {pending} 個較新版本；目前呈現仍停在 v{presented.projectionVersion}。</p> : null}
          <p className="analysis-time-range">伺服器窗口：<time dateTime={adapted?.window.windowStartEventTime}>{adapted?.window.windowStartEventTime}</time> – <time dateTime={adapted?.window.windowEndEventTime}>{adapted?.window.windowEndEventTime}</time></p>
          {presented.projectionKey === "trace.student_bundle" ? (
            <p
              className="analysis-interpretation"
              data-claim-ceiling={interpretationMatchesClaimCeiling(presented.payload.interpretation) ? "expected" : "unexpected"}
            >{TRACE_STUDENT_INTERPRETATION_ZH_HANT}</p>
          ) : null}
          <AnalysisWarnings codes={[...presented.warnings, ...(adapted?.view.warnings ?? [])]} />
          <p className="analysis-layout-note">圖上位置只用於穩定排版；關係、方向與群體指標均來自目前選取的伺服器視圖。</p>
          {!hasNetwork ? <div className="analysis-state" role="status">伺服器已返回 Projection，但目前沒有足夠互動事件形成可解讀網絡。</div>
            : <>
              <div className="analysis-graph-wrap" ref={graphRef}>
                <svg ref={svgRef} className="analysis-svg" aria-hidden="true" focusable="false" viewBox={`0 0 ${canvas.width} ${canvas.height}`}>
                  <defs>
                    <marker
                      id={markerId}
                      markerUnits="userSpaceOnUse"
                      markerWidth="11"
                      markerHeight="9"
                      orient="auto"
                      refX="10.5"
                      refY="4.5"
                    >
                      <path d="M0 0 L11 4.5 L0 9 Z" fill="var(--accent-blue)" />
                    </marker>
                  </defs>
                  {geometry.edges.map((allocated) => {
                    const edge = adapted!.edges.find(({ key }) => key === allocated.edgeId);
                    if (!edge) return null;
                    const run = Math.hypot(
                      allocated.screen.targetPort.x - allocated.screen.sourcePort.x,
                      allocated.screen.targetPort.y - allocated.screen.sourcePort.y,
                    ) || 1;
                    const label = traceLayerLabel(edge.layer);
                    return <g key={edge.key}>
                      <path className="trace-edge" d={allocated.path} markerEnd={`url(#${markerId})`} />
                      {/* A badge wider than its own run would print as mud
                          across two seats; the equivalent list still names the
                          layer of every relation. */}
                      {run >= [...label].length * 13 + 16
                        ? <text
                          className="echo-edge-label"
                          textAnchor="middle"
                          x={(allocated.screen.sourcePort.x + allocated.screen.targetPort.x) / 2}
                          y={(allocated.screen.sourcePort.y + allocated.screen.targetPort.y) / 2 - 6}
                        >{label}</text>
                        : null}
                    </g>;
                  })}
                  {geometry.nodes.map((node) => <g key={node.nodeId} transform={`translate(${node.x} ${node.y})`}>
                    <circle
                      className="trace-node"
                      r={node.rx}
                      style={identityStyle(node.label, node.kind === "agent" ? "agent" : "human")}
                    />
                    <text className="echo-node-label" textAnchor="middle" y="5">{identityInitial(node.label)}</text>
                    <text className="echo-node-sub" textAnchor="middle" y={node.rx + 20}>{node.label}</text>
                  </g>)}
                </svg>
              </div>
              <ul className="graph-legend" aria-label="互動網絡圖例">
                {kinds.map((kind) => <li className="legend-item" key={kind}>
                  {kind === "agent"
                    ? <span className="legend-dot agent" />
                    : <span className="legend-dot" style={{ background: "var(--surface-card)", borderColor: KIND_SWATCH[kind] ?? "var(--who-fallback)", borderRadius: "50%" }} />}
                  {traceNodeKindLabel(kind)}
                </li>)}
                <li className="legend-item">
                  <span className="legend-line" style={{ borderTopColor: "var(--accent-blue)" }} />
                  箭頭由發言的一方指向被回應的一方
                </li>
                {[...layerCounts].map(([layer, count]) => <li className="legend-item" key={layer}>{traceLayerLabel(layer)}：{count} 條</li>)}
                <li className="legend-item">同一位同學在聊天室與此圖使用相同顏色</li>
              </ul>
              <dl className="analysis-metrics" aria-label="群體層級指標">
                {METRICS.map(([key, label]) => <div key={key}>
                  <dt>
                    <strong>{label}</strong>
                    {METRIC_EXPLANATION[key] ? <p className="panel-meta" style={{ marginBlock: "var(--s-1) 0" }}>{METRIC_EXPLANATION[key]}</p> : null}
                  </dt>
                  <dd aria-label={label}>
                    {percent.format(adapted!.view.metrics[key])}
                    <div className="metric-track">
                      <div className="metric-fill" style={{ inlineSize: `${Math.round(adapted!.view.metrics[key] * 100)}%` }} />
                    </div>
                  </dd>
                </div>)}
              </dl>
              <div className="analysis-equivalent-list">
                <h3>網絡等價列表</h3>
                <ul aria-label="互動網絡等價列表">
                  {adapted!.nodes.map((node) => <li key={node.key}><button aria-pressed={selectedNode?.key === node.key} type="button" onClick={() => setSelectedKey(node.key)}><strong>{node.label}</strong><span>{traceNodeKindLabel(node.kind)}</span></button></li>)}
                  {adapted!.edges.map((edge) => <li key={edge.key}><button aria-pressed={selectedEdge?.key === edge.key} type="button" onClick={() => setSelectedKey(edge.key)}><strong>{edge.sourceLabel} → {edge.targetLabel}</strong><span>{layerReadingFirst(edge.layer)}</span></button></li>)}
                </ul>
              </div>
              <section className="analysis-inspector" aria-label="TRACE Inspector" aria-live="polite">
                <h3>Inspector</h3>
                {selectedNode ? <><p className="inspector-title">{selectedNode.label}</p><p>節點類型：{traceNodeKindLabel(selectedNode.kind)}</p><p>此處不產生個人排名、能力或貢獻分數。</p></>
                  : selectedEdge ? <><p className="inspector-title">{selectedEdge.sourceLabel} → {selectedEdge.targetLabel}</p><p>互動層：{layerTokenFirst(selectedEdge.layer)}</p>{selectedEdge.weight !== undefined ? <p>伺服器權重：{selectedEdge.weight}</p> : null}{selectedEdge.evidenceCount !== undefined ? <p>{selectedEdge.evidenceCount} 項伺服器證據；識別碼不在畫面顯示。</p> : null}</>
                    : <p>從等價列表選擇節點或方向以查看說明。</p>}
              </section>
            </>}
        </div>}
    </ProjectionPanelState>
  </section>;
}
