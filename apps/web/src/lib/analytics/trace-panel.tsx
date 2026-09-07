"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SnaProjectionBundle } from "@learning-orbit/contracts";
import type { ProjectionSlot } from "../session/projection-sync";
import { DEFAULT_ROOM_VIEW, type RoomViewPreferences } from "../session/room-route";
import { identityInitial, identityStyle } from "../chat/identity";
import { AnalysisWarnings } from "./analysis-warnings";
import { ProjectionPanelState } from "./projection-panel-state";
import { METRIC_EXPLANATION, traceLayerLabel, traceNodeKindLabel } from "./display-labels";

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
const PORT_FAN = 0.055;
const BOW_STEP = 26;
const ARROW_GAP = 7;
const LABEL_SPACING = 30;

type AdaptedNode = { key: string; label: string; kind: string; x: number; y: number };
type AdaptedEdge = {
  key: string;
  sourceKey: string;
  targetKey: string;
  sourceLabel: string;
  targetLabel: string;
  layer: string;
  pairRank: number;
  sourcePort: number;
  targetPort: number;
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

  // One pass to size each fan, a second to hand out the port indices, so the
  // fan stays centred on the straight line between the two nodes.
  const incidence = new Map<string, number>();
  const pairTotal = new Map<string, number>();
  const pairKey = (source: string, target: string) => [source, target].sort().join("\0");
  for (const edge of rawEdges) {
    incidence.set(edge.sourceKey, (incidence.get(edge.sourceKey) ?? 0) + 1);
    incidence.set(edge.targetKey, (incidence.get(edge.targetKey) ?? 0) + 1);
    const key = pairKey(edge.sourceKey, edge.targetKey);
    pairTotal.set(key, (pairTotal.get(key) ?? 0) + 1);
  }
  const portTaken = new Map<string, number>();
  const pairTaken = new Map<string, number>();
  const nextPort = (nodeKey: string) => {
    const taken = portTaken.get(nodeKey) ?? 0;
    portTaken.set(nodeKey, taken + 1);
    return (taken - ((incidence.get(nodeKey) ?? 1) - 1) / 2) * PORT_FAN;
  };
  const edges: AdaptedEdge[] = rawEdges.map((edge) => {
    const key = pairKey(edge.sourceKey, edge.targetKey);
    const taken = pairTaken.get(key) ?? 0;
    pairTaken.set(key, taken + 1);
    return {
      ...edge,
      pairRank: taken - ((pairTotal.get(key) ?? 1) - 1) / 2,
      sourceLabel: label.get(edge.sourceKey) ?? "未命名節點",
      targetLabel: label.get(edge.targetKey) ?? "未命名節點",
      sourcePort: nextPort(edge.sourceKey),
      targetPort: nextPort(edge.targetKey),
    };
  });
  return { window, view, nodes, edges, centreX, centreY };
}

/** Quadratic path plus the point where its predicate badge belongs. */
function edgeGeometry(
  edge: AdaptedEdge,
  source: AdaptedNode,
  target: AdaptedNode,
  centreX: number,
  centreY: number,
) {
  const selfLoop = edge.sourceKey === edge.targetKey;
  const outward = selfLoop
    ? Math.atan2(source.y - centreY, source.x - centreX) || -Math.PI / 2
    : Math.atan2(target.y - source.y, target.x - source.x);
  const startAngle = selfLoop ? outward - 0.6 + edge.sourcePort : outward + edge.sourcePort;
  const endAngle = selfLoop ? outward + 0.6 + edge.targetPort : outward + Math.PI + edge.targetPort;
  const x1 = source.x + Math.cos(startAngle) * NODE_R;
  const y1 = source.y + Math.sin(startAngle) * NODE_R;
  const x2 = target.x + Math.cos(endAngle) * (NODE_R + ARROW_GAP);
  const y2 = target.y + Math.sin(endAngle) * (NODE_R + ARROW_GAP);
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const chord = Math.hypot(x2 - x1, y2 - y1) || 1;
  // A desktop-sized bow on a phone-sized chord curls into a loop, so the bow
  // is capped by the run it has to travel.
  const bow = edge.pairRank * Math.min(BOW_STEP, Math.max(9, chord * 0.3));
  let controlX: number;
  let controlY: number;
  if (selfLoop) {
    const reach = NODE_R * 2.6 + Math.abs(bow);
    controlX = source.x + Math.cos(outward) * reach;
    controlY = source.y + Math.sin(outward) * reach;
  } else {
    controlX = midX + (-(y2 - y1) / chord) * bow;
    controlY = midY + ((x2 - x1) / chord) * bow;
  }
  // Parallel relations bow apart, but their badges would still stack, so each
  // one is parked a fixed number of pixels further along its own curve.
  const t = Math.min(0.82, Math.max(0.18, 0.5 + (edge.pairRank * LABEL_SPACING) / chord));
  const start = (1 - t) * (1 - t);
  const middle = 2 * (1 - t) * t;
  const end = t * t;
  return {
    chord,
    path: `M ${x1} ${y1} Q ${controlX} ${controlY} ${x2} ${y2}`,
    labelX: start * x1 + middle * controlX + end * x2,
    labelY: start * y1 + middle * controlY + end * y2 - 8,
  };
}

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
          {presented.projectionKey === "trace.student_bundle" ? <p className="analysis-interpretation">{presented.payload.interpretation}</p> : null}
          <AnalysisWarnings codes={[...presented.warnings, ...(adapted?.view.warnings ?? [])]} />
          <p className="analysis-layout-note">圖上位置只用於穩定排版；關係、方向與群體指標均來自目前選取的伺服器視圖。</p>
          {!hasNetwork ? <div className="analysis-state" role="status">伺服器已返回 Projection，但目前沒有足夠互動事件形成可解讀網絡。</div>
            : <>
              <div className="analysis-graph-wrap" ref={graphRef}>
                <svg className="analysis-svg" aria-hidden="true" focusable="false" viewBox={`0 0 ${canvas.width} ${canvas.height}`}>
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
                  {adapted!.edges.map((edge) => {
                    const source = adapted!.nodes.find(({ key }) => key === edge.sourceKey);
                    const target = adapted!.nodes.find(({ key }) => key === edge.targetKey);
                    if (!source || !target) return null;
                    const geometry = edgeGeometry(edge, source, target, adapted!.centreX, adapted!.centreY);
                    return <g key={edge.key}>
                      <path className="trace-edge" d={geometry.path} markerEnd={`url(#${markerId})`} />
                      {/* A badge wider than its own run would print as mud
                          across two seats; the equivalent list still names the
                          layer of every relation. */}
                      {geometry.chord >= [...traceLayerLabel(edge.layer)].length * 13 + 16
                        ? <text className="echo-edge-label" textAnchor="middle" x={geometry.labelX} y={geometry.labelY}>{traceLayerLabel(edge.layer)}</text>
                        : null}
                    </g>;
                  })}
                  {adapted!.nodes.map((node) => <g key={node.key} transform={`translate(${node.x} ${node.y})`}>
                    <circle
                      className="trace-node"
                      r={NODE_R}
                      style={identityStyle(node.label, node.kind === "agent" ? "agent" : "human")}
                    />
                    <text className="echo-node-label" textAnchor="middle" y="5">{identityInitial(node.label)}</text>
                    <text className="echo-node-sub" textAnchor="middle" y={NODE_R + 20}>{node.label}</text>
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
