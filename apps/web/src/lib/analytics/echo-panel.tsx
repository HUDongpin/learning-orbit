"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  type AnalyticsTimelineResponse,
  type ConceptMapSnapshot,
} from "@learning-orbit/contracts";
import type { ProjectionSlot } from "../session/projection-sync";
import { SessionGatewayError } from "../session/session-gateway";
import { applyConceptPatch } from "./concept-reducer";
import { AnalysisWarnings } from "./analysis-warnings";
import { ProjectionPanelState } from "./projection-panel-state";

type Selection = Readonly<{ kind: "node" | "edge"; key: string }>;
type TimelineView = Readonly<{
  analysisEpoch: string;
  entries: readonly Readonly<{ version: number; snapshot?: ConceptMapSnapshot }>[];
  headVersion: number;
  projectionKey: ConceptMapSnapshot["projectionKey"];
  truncatedBeforeVersion: number | null;
}>;

function timelineView(response: AnalyticsTimelineResponse): TimelineView {
  const entries: Array<{ version: number; snapshot?: ConceptMapSnapshot }> = [];
  let current: ConceptMapSnapshot | undefined = response.baseSnapshot ?? undefined;
  if (current) entries.push({ version: current.projectionVersion, snapshot: current });
  for (const patch of response.patches) {
    if (current) {
      current = applyConceptPatch(current, patch);
      entries.push({ version: current.projectionVersion, snapshot: current });
    } else {
      entries.push({ version: patch.projectionVersion });
    }
  }
  if (current && current.projectionVersion !== response.headVersion) throw new Error("ANALYTICS_TIMELINE_HEAD_MISMATCH");
  return {
    analysisEpoch: response.analysisEpoch,
    entries,
    headVersion: response.headVersion,
    projectionKey: response.projectionKey,
    truncatedBeforeVersion: response.truncatedBeforeVersion,
  };
}

function safeTimelineError(error: unknown): string {
  if (error instanceof SessionGatewayError) return error.code;
  return error instanceof Error && /^[A-Z0-9_]{1,80}$/u.test(error.message)
    ? error.message
    : "ANALYTICS_TIMELINE_FAILED";
}

export function EchoPanel({ slot, onLoadTimeline, onRetry }: Readonly<{
  slot: ProjectionSlot;
  onLoadTimeline?: () => Promise<AnalyticsTimelineResponse>;
  onRetry: () => void;
}>) {
  const [selection, setSelection] = useState<Selection>();
  const [timeline, setTimeline] = useState<TimelineView>();
  const [timelineStatus, setTimelineStatus] = useState<"idle" | "loading" | "failed">("idle");
  const [timelineError, setTimelineError] = useState<string>();
  const [previewVersion, setPreviewVersion] = useState<number>();
  const timelineGeneration = useRef(0);
  const canonical = slot.snapshot && (slot.snapshot.projectionKey === "echo.student_approved" || slot.snapshot.projectionKey === "echo.teacher_shadow")
    ? slot.snapshot as ConceptMapSnapshot : undefined;
  const currentTimeline = canonical && timeline?.projectionKey === canonical.projectionKey
    && timeline.analysisEpoch === canonical.analysisEpoch ? timeline : undefined;
  const previewSnapshot = previewVersion === undefined
    ? undefined
    : currentTimeline?.entries.find(({ version }) => version === previewVersion)?.snapshot;
  const snapshot = previewSnapshot ?? canonical;
  const showingPreview = previewSnapshot !== undefined;

  useEffect(() => {
    timelineGeneration.current += 1;
    setTimeline(undefined);
    setTimelineStatus("idle");
    setTimelineError(undefined);
    setPreviewVersion(undefined);
    setSelection(undefined);
    return () => { timelineGeneration.current += 1; };
  }, [canonical?.analysisEpoch, canonical?.projectionKey, canonical?.projectionVersion]);

  const nodeById = useMemo(() => new Map(snapshot?.payload.nodes.map((node) => [node.nodeId, node]) ?? []), [snapshot]);
  const selectedNode = selection?.kind === "node" ? nodeById.get(selection.key) : undefined;
  const selectedEdge = selection?.kind === "edge" ? snapshot?.payload.edges.find(({ edgeId }) => edgeId === selection.key) : undefined;
  const hasContent = Boolean(snapshot && (snapshot.payload.nodes.length > 0 || snapshot.payload.edges.length > 0));

  return <section className="orbit-panel analysis-panel server-analysis-panel" aria-labelledby="echo-panel-title">
    <header className="panel-head">
      <div><span className="panel-kicker">ECHO-CM</span><h2 className="panel-title" id="echo-panel-title">概念與論證</h2></div>
      {snapshot ? <span className="analysis-version" aria-label={`Projection 版本 ${snapshot.projectionVersion}`}>{showingPreview ? "歷史 v" : "v"}{snapshot.projectionVersion}</span> : null}
    </header>
    <ProjectionPanelState slot={slot} onRetry={onRetry} panelName="ECHO-CM" retryLabel="重新檢查 ECHO 權限">
      {!snapshot ? <div className="analysis-state analysis-state-error" role="alert">ECHO Projection 類型與角色不一致。</div>
        : !hasContent ? <div className="analysis-state" role="status">
          {snapshot.projectionKey === "echo.student_approved"
            ? "此課堂已開放 ECHO-CM，但尚無教師批准的概念或關係。"
            : "伺服器目前尚無可顯示的概念或關係。"}
        </div>
          : <div className="analysis-content">
            <AnalysisWarnings codes={snapshot.warnings} />
            {onLoadTimeline ? <div className="echo-timeline-controls">
              <button disabled={timelineStatus === "loading"} type="button" onClick={() => {
                const generation = timelineGeneration.current + 1;
                timelineGeneration.current = generation;
                setTimelineStatus("loading");
                setTimelineError(undefined);
                void onLoadTimeline().then((response) => {
                  if (timelineGeneration.current !== generation) return;
                  if (!canonical || response.projectionKey !== canonical.projectionKey || response.analysisEpoch !== canonical.analysisEpoch) {
                    throw new Error("ANALYTICS_TIMELINE_CONTEXT_MISMATCH");
                  }
                  setTimeline(timelineView(response));
                  setTimelineStatus("idle");
                }).catch((error: unknown) => {
                  if (timelineGeneration.current !== generation) return;
                  setTimelineError(safeTimelineError(error));
                  setTimelineStatus("failed");
                });
              }}>{timelineStatus === "loading" ? "正在載入版本時間線…" : "查看版本時間線"}</button>
              {showingPreview ? <button type="button" onClick={() => { setPreviewVersion(undefined); setSelection(undefined); }}>返回最新已驗證版本</button> : null}
            </div> : null}
            {timelineStatus === "loading" ? <p className="analysis-refreshing" role="status">正在核對同一 Analysis Epoch 的 ECHO-CM Timeline…</p> : null}
            {timelineStatus === "failed" ? <p className="analysis-state analysis-state-warning" role="alert">版本時間線未能通過驗證。錯誤代碼：{timelineError}</p> : null}
            {currentTimeline ? <section className="echo-timeline" aria-label="ECHO Timeline">
              <div><h3>版本時間線</h3><p>伺服器 Head：v{currentTimeline.headVersion}</p></div>
              {currentTimeline.truncatedBeforeVersion !== null ? <p>較早版本已按保留政策截斷；目前基線為 v{currentTimeline.truncatedBeforeVersion}。</p> : null}
              {currentTimeline.entries.length === 0 ? <p role="status">此 Analysis Epoch 尚無可列出的版本。</p> : <ol>
                {currentTimeline.entries.map((entry) => <li key={entry.version}>
                  {entry.snapshot ? <button aria-pressed={previewVersion === entry.version} type="button" onClick={() => { setPreviewVersion(entry.version); setSelection(undefined); }}>預覽 v{entry.version}</button>
                    : <span>v{entry.version} Patch（伺服器未提供可重建的基線）</span>}
                </li>)}
              </ol>}
            </section> : null}
            <div className="analysis-graph-wrap">
              <svg className="analysis-svg" aria-hidden="true" focusable="false" viewBox="0 0 1000 520">
                {snapshot.payload.edges.map((edge) => {
                  const head = nodeById.get(edge.head);
                  const tail = nodeById.get(edge.tail);
                  if (!head || !tail) return null;
                  const x1 = 60 + head.position.x * 880;
                  const y1 = 50 + head.position.y * 420;
                  const x2 = 60 + tail.position.x * 880;
                  const y2 = 50 + tail.position.y * 420;
                  return <g key={edge.edgeId}>
                    <line className={`echo-edge status-${edge.displayStatus}`} x1={x1} y1={y1} x2={x2} y2={y2} />
                    <text className="echo-edge-label" x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8}>{edge.predicate}</text>
                  </g>;
                })}
                {snapshot.payload.nodes.map((node) => {
                  const x = 60 + node.position.x * 880;
                  const y = 50 + node.position.y * 420;
                  return <g key={node.nodeId} transform={`translate(${x} ${y})`}>
                    <circle className={`echo-node status-${node.displayStatus}`} r="34" />
                    <text className="echo-node-label" textAnchor="middle" y="4">{node.label}</text>
                  </g>;
                })}
              </svg>
            </div>
            <div className="analysis-equivalent-list">
              <h3>概念與關係列表</h3>
              <ul aria-label="概念關係等價列表">
                {snapshot.payload.nodes.map((node) => <li key={node.nodeId}>
                  <button aria-pressed={selectedNode?.nodeId === node.nodeId} type="button" onClick={() => setSelection({ kind: "node", key: node.nodeId })}>
                    <strong>{node.label}</strong><span>{node.evidenceStatus}</span>
                  </button>
                </li>)}
                {snapshot.payload.edges.map((edge) => {
                  const head = nodeById.get(edge.head)?.label ?? edge.head;
                  const tail = nodeById.get(edge.tail)?.label ?? edge.tail;
                  return <li key={edge.edgeId}>
                    <button aria-pressed={selectedEdge?.edgeId === edge.edgeId} aria-label={`${head} ${edge.predicate} ${tail}`} type="button" onClick={() => setSelection({ kind: "edge", key: edge.edgeId })}>
                      <strong>{head} → {tail}</strong><span>{edge.predicate}</span>
                    </button>
                  </li>;
                })}
              </ul>
            </div>
            <section className="analysis-inspector" aria-label="ECHO Inspector">
              <h3>Inspector</h3>
              {selectedNode ? <><p className="inspector-title">{selectedNode.label}</p><p>伺服器證據狀態：{selectedNode.evidenceStatus}</p><p>顯示狀態：{selectedNode.displayStatus}</p></>
                : selectedEdge ? <>
                  <p className="inspector-title">{nodeById.get(selectedEdge.head)?.label} {selectedEdge.predicate} {nodeById.get(selectedEdge.tail)?.label}</p>
                  <p>關係類型：{selectedEdge.relationFamily}</p><p>伺服器證據狀態：{selectedEdge.evidenceStatus}</p>
                  {"evidenceRefs" in selectedEdge && Array.isArray(selectedEdge.evidenceRefs)
                    ? <p>{selectedEdge.evidenceRefs.length} 項伺服器證據；識別碼不在畫面顯示。</p> : null}
                  {"channels" in selectedEdge && selectedEdge.channels
                    ? <p>支持 {selectedEdge.channels.support} · 挑戰 {selectedEdge.channels.challenge} · 不確定 {selectedEdge.channels.uncertain} · 提問 {selectedEdge.channels.question}</p> : null}
                </> : <p>從等價列表選擇一個概念或關係以查看伺服器狀態。</p>}
            </section>
          </div>}
    </ProjectionPanelState>
  </section>;
}
