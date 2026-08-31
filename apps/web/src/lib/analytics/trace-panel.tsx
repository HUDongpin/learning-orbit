"use client";

import React, { useEffect, useMemo, useState } from "react";
import type { SnaProjectionBundle } from "@learning-orbit/contracts";
import type { ProjectionSlot } from "../session/projection-sync";
import { AnalysisWarnings } from "./analysis-warnings";
import { ProjectionPanelState } from "./projection-panel-state";

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

type AdaptedNode = { key: string; label: string; kind: string; x: number; y: number };
type AdaptedEdge = { key: string; sourceKey: string; targetKey: string; sourceLabel: string; targetLabel: string; layer: string; weight?: number; evidenceCount?: number };

function adapt(bundle: TraceBundle, windowName: WindowName, viewName: ViewName) {
  const window = bundle.payload.windows[windowName];
  const view = window.views[viewName];
  const sorted = [...view.nodes].sort((left, right) => left.label.localeCompare(right.label, "zh-Hant"));
  const nodes: AdaptedNode[] = sorted.map((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, sorted.length) - Math.PI / 2;
    return { key: node.nodeId, label: node.label, kind: node.kind, x: 500 + Math.cos(angle) * 320, y: 260 + Math.sin(angle) * 180 };
  });
  const label = new Map(nodes.map((node) => [node.key, node.label]));
  const edges: AdaptedEdge[] = view.edges.map((edge, index) => {
    const sourceKey = "sourceNodeId" in edge ? edge.sourceNodeId : edge.sourceId;
    const targetKey = "targetNodeId" in edge ? edge.targetNodeId : edge.targetId;
    return {
      key: "edgeId" in edge ? edge.edgeId : `${sourceKey}\0${targetKey}\0${edge.layer}\0${index}`,
      sourceKey,
      targetKey,
      sourceLabel: label.get(sourceKey) ?? "未命名節點",
      targetLabel: label.get(targetKey) ?? "未命名節點",
      layer: edge.layer,
      ...("weight" in edge ? { weight: edge.weight } : {}),
      ...("evidenceRefs" in edge && Array.isArray(edge.evidenceRefs) ? { evidenceCount: edge.evidenceRefs.length } : {}),
    };
  });
  return { window, view, nodes, edges };
}

export function TracePanel({ slot, onRetry }: Readonly<{ slot: ProjectionSlot; onRetry: () => void }>) {
  const canonical = slot.snapshot && (slot.snapshot.projectionKey === "trace.student_bundle" || slot.snapshot.projectionKey === "trace.teacher_bundle")
    ? slot.snapshot as TraceBundle : undefined;
  const [storedPresented, setPresented] = useState<TraceBundle | undefined>(() => canonical);
  const [paused, setPaused] = useState(false);
  const [windowName, setWindowName] = useState<WindowName>("recent_10m");
  const [viewName, setViewName] = useState<ViewName>("observed");
  const [selectedKey, setSelectedKey] = useState<string>();

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

  const adapted = useMemo(() => presented ? adapt(presented, windowName, viewName) : undefined, [presented, viewName, windowName]);
  const selectedNode = adapted?.nodes.find(({ key }) => key === selectedKey);
  const selectedEdge = adapted?.edges.find(({ key }) => key === selectedKey);
  const pending = canonical && presented && (canonical.analysisEpoch !== presented.analysisEpoch
    ? 1 : Math.max(0, canonical.projectionVersion - presented.projectionVersion));
  const hasNetwork = Boolean(adapted && (adapted.nodes.length > 0 || adapted.edges.length > 0));

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
              <div className="analysis-graph-wrap">
                <svg className="analysis-svg" aria-hidden="true" focusable="false" viewBox="0 0 1000 520">
                  {adapted!.edges.map((edge) => {
                    const source = adapted!.nodes.find(({ key }) => key === edge.sourceKey);
                    const target = adapted!.nodes.find(({ key }) => key === edge.targetKey);
                    if (!source || !target) return null;
                    return <g key={edge.key}><line className="trace-edge" x1={source.x} y1={source.y} x2={target.x} y2={target.y} /><text className="echo-edge-label" x={(source.x + target.x) / 2} y={(source.y + target.y) / 2 - 8}>{edge.layer}</text></g>;
                  })}
                  {adapted!.nodes.map((node) => <g key={node.key} transform={`translate(${node.x} ${node.y})`}><circle className="trace-node" r="34" /><text className="echo-node-label" textAnchor="middle" y="4">{node.label}</text></g>)}
                </svg>
              </div>
              <dl className="analysis-metrics" aria-label="群體層級指標">
                {METRICS.map(([key, label]) => <div key={key}><dt>{label}</dt><dd aria-label={label}>{percent.format(adapted!.view.metrics[key])}</dd></div>)}
              </dl>
              <div className="analysis-equivalent-list">
                <h3>網絡等價列表</h3>
                <ul aria-label="互動網絡等價列表">
                  {adapted!.nodes.map((node) => <li key={node.key}><button aria-pressed={selectedNode?.key === node.key} type="button" onClick={() => setSelectedKey(node.key)}><strong>{node.label}</strong><span>{node.kind}</span></button></li>)}
                  {adapted!.edges.map((edge) => <li key={edge.key}><button aria-pressed={selectedEdge?.key === edge.key} type="button" onClick={() => setSelectedKey(edge.key)}><strong>{edge.sourceLabel} → {edge.targetLabel}</strong><span>{edge.layer}</span></button></li>)}
                </ul>
              </div>
              <section className="analysis-inspector" aria-label="TRACE Inspector" aria-live="polite">
                <h3>Inspector</h3>
                {selectedNode ? <><p className="inspector-title">{selectedNode.label}</p><p>節點類型：{selectedNode.kind}</p><p>此處不產生個人排名、能力或貢獻分數。</p></>
                  : selectedEdge ? <><p className="inspector-title">{selectedEdge.sourceLabel} → {selectedEdge.targetLabel}</p><p>互動層：{selectedEdge.layer}</p>{selectedEdge.weight !== undefined ? <p>伺服器權重：{selectedEdge.weight}</p> : null}{selectedEdge.evidenceCount !== undefined ? <p>{selectedEdge.evidenceCount} 項伺服器證據；識別碼不在畫面顯示。</p> : null}</>
                    : <p>從等價列表選擇節點或方向以查看說明。</p>}
              </section>
            </>}
        </div>}
    </ProjectionPanelState>
  </section>;
}
