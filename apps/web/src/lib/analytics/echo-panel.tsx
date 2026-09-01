"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  type AnalyticsTimelineResponse,
  type ConceptMapSnapshot,
} from "@learning-orbit/contracts";
import type { ProjectionSlot } from "../session/projection-sync";
import { SessionGatewayError } from "../session/session-gateway";
import { applyConceptPatch } from "./concept-reducer";
import { AnalysisWarnings } from "./analysis-warnings";
import { ProjectionPanelState } from "./projection-panel-state";
import { displayStatusLabel, evidenceStatusLabel, statusBadgeClass } from "./display-labels";

type Selection = Readonly<{ kind: "node" | "edge"; key: string }>;
type TimelineView = Readonly<{
  analysisEpoch: string;
  entries: readonly Readonly<{ version: number; snapshot?: ConceptMapSnapshot }>[];
  headVersion: number;
  projectionKey: ConceptMapSnapshot["projectionKey"];
  truncatedBeforeVersion: number | null;
}>;

/**
 * The four per-element `displayStatus` values in
 * `echo-concept-projection.v1.json`. Each one has a stroke colour AND a dash
 * signature in globals.css, so the epistemic state of a concept survives
 * colour-vision deficiency, a washed-out projector, and a greyscale printout.
 * The same four are named in words in the legend, the equivalent list, the
 * Inspector, and inside the node itself — colour is never the only channel.
 */
const DISPLAY_STATUSES = ["confirmed", "provisional", "disputed", "inactive"] as const;
type DisplayStatus = typeof DISPLAY_STATUSES[number];
const isDisplayStatus = (value: string): value is DisplayStatus =>
  (DISPLAY_STATUSES as readonly string[]).includes(value);

/** Legend swatches reuse the authored `.legend-line` modifiers where they exist. */
const LEGEND_LINE: Readonly<Record<DisplayStatus, string>> = {
  confirmed: "legend-line",
  provisional: "legend-line provisional",
  disputed: "legend-line disputed",
  inactive: "legend-line",
};

/* ---------------------------------------------------------------------------
   Canvas measurement.

   A fixed viewBox makes one SVG unit shrink with the panel: at 320px the 15px
   node label used to render at about 7 CSS px, which is unreadable for Han
   glyphs. Measuring the wrapper and building the viewBox from that box makes
   one SVG unit exactly one CSS pixel at every width, so the type sizes
   authored in globals.css are the sizes a student actually sees.
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
   Node boxes.

   The schema allows a 160-character label. A circle of r=34 clipped all but a
   few glyphs of it, so every long concept looked identical to every other long
   concept. Nodes are now rounded rects measured from the label: Han glyphs sit
   on a full em square, Latin on roughly half of one, which is close enough to
   size a box without measuring text in the DOM. Anything past the clamp is
   truncated with an ellipsis, and the untruncated label stays in the
   equivalent list where a student can always read it in full.
   ------------------------------------------------------------------------ */
const NODE_FONT = 15;
const SUB_FONT = 13;
const NODE_PAD_X = 15;
const NODE_MIN_WIDTH = 108;
const NODE_HALF_HEIGHT = 27;
const MARGIN_X = 58;
const MARGIN_Y = 44;
const PARALLEL_STEP = 17;
const LABEL_SPACING = 26;
const WIDE_GLYPH = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u2026\u3000-\u303f\uff01-\uff60]/u;

const glyphUnits = (character: string): number => (WIDE_GLYPH.test(character) ? 1 : 0.56);
const textUnits = (text: string): number =>
  [...text].reduce((total, character) => total + glyphUnits(character), 0);
const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

function truncateLabel(label: string, maxUnits: number): string {
  if (textUnits(label) <= maxUnits) return label;
  let units = 0;
  let kept = "";
  for (const character of label) {
    const next = units + glyphUnits(character);
    if (next > maxUnits - 1) break;
    units = next;
    kept += character;
  }
  return `${kept}…`;
}

type NodeBox = Readonly<{
  x: number;
  y: number;
  halfWidth: number;
  status: string;
  text: string;
}>;

/** Where a ray leaving the box centre crosses the box edge, plus a gap. */
function boundary(box: NodeBox, dx: number, dy: number, gap: number): Readonly<{ x: number; y: number }> {
  const length = Math.hypot(dx, dy) || 1;
  const scale = Math.min(
    box.halfWidth / Math.max(Math.abs(dx), 1e-6),
    NODE_HALF_HEIGHT / Math.max(Math.abs(dy), 1e-6),
  ) + gap / length;
  return { x: box.x + dx * scale, y: box.y + dy * scale };
}

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
  const [graphRef, canvas] = useMeasuredCanvas();
  const markerBase = useId().replace(/[^a-zA-Z0-9_-]/gu, "");
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

  const graph = useMemo(() => {
    const boxes = new Map<string, NodeBox>();
    // Rank of a relation among the relations sharing its two concepts: 0 when
    // it is the only one, and symmetric around 0 otherwise.
    const lanes = new Map<string, number>();
    if (!snapshot) return { boxes, lanes };
    const maxWidth = clamp(canvas.width * 0.3, NODE_MIN_WIDTH, 252);
    const maxUnits = (maxWidth - NODE_PAD_X * 2) / NODE_FONT;
    // On a phone the fixed desktop margin would squeeze four concepts into the
    // middle third of the canvas, so it shrinks with the box.
    const marginX = Math.min(MARGIN_X, canvas.width * 0.1);
    const marginY = Math.min(MARGIN_Y, canvas.height * 0.12);
    const spanX = Math.max(1, canvas.width - marginX * 2);
    const spanY = Math.max(1, canvas.height - marginY * 2);
    for (const node of snapshot.payload.nodes) {
      const text = truncateLabel(node.label, maxUnits);
      const status = displayStatusLabel(node.displayStatus);
      const content = Math.max(textUnits(text) * NODE_FONT, textUnits(status) * SUB_FONT);
      const halfWidth = clamp(Math.round(content) + NODE_PAD_X * 2, NODE_MIN_WIDTH, maxWidth) / 2;
      boxes.set(node.nodeId, {
        halfWidth,
        status,
        text,
        x: clamp(marginX + node.position.x * spanX, halfWidth + 6, canvas.width - halfWidth - 6),
        y: clamp(marginY + node.position.y * spanY, NODE_HALF_HEIGHT + 6, canvas.height - NODE_HALF_HEIGHT - 6),
      });
    }
    // Two concepts can carry several distinct predicates. Without a per-pair
    // offset those relations stack into one stroke and the map silently loses
    // an argument the class actually made.
    const pairKey = (head: string, tail: string) => [head, tail].sort().join(" ");
    const totals = new Map<string, number>();
    for (const edge of snapshot.payload.edges) {
      const key = pairKey(edge.head, edge.tail);
      totals.set(key, (totals.get(key) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    for (const edge of snapshot.payload.edges) {
      const key = pairKey(edge.head, edge.tail);
      const taken = seen.get(key) ?? 0;
      seen.set(key, taken + 1);
      lanes.set(edge.edgeId, taken - ((totals.get(key) ?? 1) - 1) / 2);
    }
    return { boxes, lanes };
  }, [snapshot, canvas.width, canvas.height]);

  return <section className="orbit-panel analysis-panel server-analysis-panel" aria-labelledby="echo-panel-title">
    <header className="panel-head">
      <div>
        <span className="panel-kicker">ECHO-CM</span>
        <h2 className="panel-title" id="echo-panel-title">概念與論證</h2>
        {snapshot ? <span className="panel-count" style={{ marginBlockStart: "var(--s-2)" }}>
          本圖共 {snapshot.payload.nodes.length} 個概念 · {snapshot.payload.edges.length} 條關係
        </span> : null}
      </div>
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
              {currentTimeline.entries.length === 0 ? <p role="status">此 Analysis Epoch 尚無可列出的版本。</p>
                : <ol aria-label="ECHO 版本時間線" tabIndex={0}>
                {currentTimeline.entries.map((entry) => <li key={entry.version}>
                  {entry.snapshot ? <button aria-pressed={previewVersion === entry.version} type="button" onClick={() => { setPreviewVersion(entry.version); setSelection(undefined); }}>預覽 v{entry.version}</button>
                    : <span>v{entry.version} Patch（伺服器未提供可重建的基線）</span>}
                </li>)}
              </ol>}
            </section> : null}
            <div className="analysis-graph-wrap" ref={graphRef}>
              <svg className="analysis-svg" aria-hidden="true" focusable="false" viewBox={`0 0 ${canvas.width} ${canvas.height}`}>
                <defs>
                  {DISPLAY_STATUSES.map((status) => <marker
                    key={status}
                    id={`echo-arrow-${markerBase}-${status}`}
                    markerUnits="userSpaceOnUse"
                    markerWidth="11"
                    markerHeight="9"
                    orient="auto"
                    refX="10.5"
                    refY="4.5"
                  >
                    <path d="M0 0 L11 4.5 L0 9 Z" fill={`var(--st-${status}-stroke)`} />
                  </marker>)}
                </defs>
                {snapshot.payload.edges.map((edge) => {
                  const from = graph.boxes.get(edge.head);
                  const to = graph.boxes.get(edge.tail);
                  if (!from || !to) return null;
                  const dx = to.x - from.x;
                  const dy = to.y - from.y;
                  const length = Math.hypot(dx, dy);
                  if (length < 1) return null;
                  const rank = graph.lanes.get(edge.edgeId) ?? 0;
                  const shiftX = (-dy / length) * rank * PARALLEL_STEP;
                  const shiftY = (dx / length) * rank * PARALLEL_STEP;
                  const start = boundary(from, dx, dy, 3);
                  const end = boundary(to, -dx, -dy, 4);
                  const x1 = start.x + shiftX;
                  const y1 = start.y + shiftY;
                  const x2 = end.x + shiftX;
                  const y2 = end.y + shiftY;
                  // The drawn run, not the centre distance: on a phone two node
                  // boxes can nearly touch while their centres are far apart.
                  const run = Math.hypot(x2 - x1, y2 - y1) || 1;
                  // Sibling relations bow apart; their predicates park a fixed
                  // number of pixels apart along the run, not a fixed fraction,
                  // so a short run separates them as well as a long one.
                  const labelAt = clamp(0.5 + (rank * LABEL_SPACING) / run, 0.18, 0.82);
                  return <g key={edge.edgeId}>
                    <line
                      className={`echo-edge status-${edge.displayStatus}`}
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      {...(isDisplayStatus(edge.displayStatus)
                        ? { markerEnd: `url(#echo-arrow-${markerBase}-${edge.displayStatus})` }
                        : {})}
                    />
                    {/* A predicate wider than its own run would print as mud
                        across two node boxes. It stays in the equivalent list,
                        which is the readable source of truth either way. */}
                    {run >= textUnits(edge.predicate) * SUB_FONT + 16 ? <text
                      className="echo-edge-label"
                      textAnchor="middle"
                      x={x1 + (x2 - x1) * labelAt + (-dy / length) * 11}
                      y={y1 + (y2 - y1) * labelAt + (dx / length) * 11 + 4}
                    >{edge.predicate}</text> : null}
                  </g>;
                })}
                {snapshot.payload.nodes.map((node) => {
                  const box = graph.boxes.get(node.nodeId);
                  if (!box) return null;
                  return <g key={node.nodeId} transform={`translate(${box.x} ${box.y})`}>
                    <rect
                      className={`echo-node status-${node.displayStatus}`}
                      height={NODE_HALF_HEIGHT * 2}
                      rx="13"
                      width={box.halfWidth * 2}
                      x={-box.halfWidth}
                      y={-NODE_HALF_HEIGHT}
                    />
                    <text className="echo-node-label" textAnchor="middle" y="-2">{box.text}</text>
                    <text className="echo-node-sub" textAnchor="middle" y="17">{box.status}</text>
                  </g>;
                })}
              </svg>
            </div>
            <ul className="graph-legend" aria-label="概念與關係狀態圖例">
              {DISPLAY_STATUSES.map((status) => <li className="legend-item" key={status}>
                <span
                  className="legend-dot"
                  style={{ background: `var(--st-${status}-fill)`, borderColor: `var(--st-${status}-stroke)` }}
                />
                <span
                  className={LEGEND_LINE[status]}
                  style={status === "inactive"
                    ? { borderTopColor: "var(--st-inactive-stroke)", borderTopStyle: "dotted" }
                    : { borderTopColor: `var(--st-${status}-stroke)` }}
                />
                {displayStatusLabel(status)}
              </li>)}
            </ul>
            <div className="analysis-equivalent-list">
              <h3>概念與關係列表</h3>
              <ul aria-label="概念關係等價列表">
                {snapshot.payload.nodes.map((node) => <li key={node.nodeId}>
                  <button aria-pressed={selectedNode?.nodeId === node.nodeId} type="button" onClick={() => setSelection({ kind: "node", key: node.nodeId })}>
                    <strong>{node.label}</strong>
                    <b className={statusBadgeClass(node.displayStatus)}>{displayStatusLabel(node.displayStatus)}</b>
                    <span>{evidenceStatusLabel(node.evidenceStatus)}</span>
                  </button>
                </li>)}
                {snapshot.payload.edges.map((edge) => {
                  const head = nodeById.get(edge.head)?.label ?? edge.head;
                  const tail = nodeById.get(edge.tail)?.label ?? edge.tail;
                  return <li key={edge.edgeId}>
                    <button aria-pressed={selectedEdge?.edgeId === edge.edgeId} aria-label={`${head} ${edge.predicate} ${tail}`} type="button" onClick={() => setSelection({ kind: "edge", key: edge.edgeId })}>
                      <strong>{head} → {tail}</strong>
                      <b className={statusBadgeClass(edge.displayStatus)}>{displayStatusLabel(edge.displayStatus)}</b>
                      <span>{edge.predicate}</span>
                    </button>
                  </li>;
                })}
              </ul>
            </div>
            <section className="analysis-inspector" aria-label="ECHO Inspector" aria-live="polite">
              <h3>Inspector</h3>
              {selectedNode ? <>
                <p className="inspector-title">{selectedNode.label}</p>
                <p>顯示狀態：<b className={statusBadgeClass(selectedNode.displayStatus)}>{displayStatusLabel(selectedNode.displayStatus)}</b></p>
                <p>伺服器證據狀態：{evidenceStatusLabel(selectedNode.evidenceStatus)}</p>
              </>
                : selectedEdge ? <>
                  <p className="inspector-title">{nodeById.get(selectedEdge.head)?.label} {selectedEdge.predicate} {nodeById.get(selectedEdge.tail)?.label}</p>
                  <p>顯示狀態：<b className={statusBadgeClass(selectedEdge.displayStatus)}>{displayStatusLabel(selectedEdge.displayStatus)}</b></p>
                  <p>關係類型：{selectedEdge.relationFamily}</p>
                  <p>伺服器證據狀態：{evidenceStatusLabel(selectedEdge.evidenceStatus)}</p>
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
