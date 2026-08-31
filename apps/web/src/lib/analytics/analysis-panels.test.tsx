import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  analyticsContract,
  analyticsHttpContract,
  type SnaProjectionBundle,
  type StudentConceptMapSnapshot,
  type TeacherConceptMapSnapshot,
} from "@learning-orbit/contracts";
import goldenEcho from "../../../../../packages/test-fixtures/analytics/golden-echo-projection.json" with { type: "json" };
import type { ProjectionSlot } from "../session/projection-sync.js";
import { EchoPanel } from "./echo-panel.js";
import { TracePanel } from "./trace-panel.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const EPOCH = "00000000-0000-4000-8000-000000000901";
const NEXT_EPOCH = "00000000-0000-4000-8000-000000000902";
const EDGE_ID = "00000000-0000-5000-8000-000000000701";
const EVENT_ID = "00000000-0000-4000-8000-000000000702";

function studentEcho(version = 1, epoch = EPOCH, firstLabel?: string): StudentConceptMapSnapshot {
  return analyticsContract.parseStudentEchoSnapshot({
    ...goldenEcho,
    projectionKey: "echo.student_approved",
    analysisEpoch: epoch,
    reviewStatus: "approved",
    displayStatus: "student_approved",
    projectionVersion: version,
    baseVersion: version - 1,
    completeThroughRoomSeq: version + 4,
    payload: {
      nodes: goldenEcho.payload.nodes.map((node, index) => ({
        ...node,
        ...(index === 0 && firstLabel ? { label: firstLabel } : {}),
        reviewStatus: "approved",
      })),
      edges: goldenEcho.payload.edges.map(({ channels: _channels, activityScore: _score, evidenceRefs: _refs, ...edge }) => ({
        ...edge,
        reviewStatus: "approved",
      })),
    },
  });
}

function studentTimeline() {
  const patch = analyticsContract.parseStudentEchoPatch({
    analysisEpoch: EPOCH,
    algorithmVersion: goldenEcho.algorithmVersion,
    parameterHash: goldenEcho.parameterHash,
    projectionVersion: 2,
    baseVersion: 1,
    completeThroughRoomSeq: 6,
    requiresReplay: false,
    warnings: [],
    nodesAdded: [],
    nodesUpdated: [],
    nodesHidden: [],
    edgesAdded: [],
    edgesUpdated: [],
    edgesHidden: [],
    positionUpdates: [],
    changeScore: 0,
    reasonCodes: ["server_verified"],
  });
  return analyticsHttpContract.parseStudentTimeline({
    schemaVersion: 1,
    roomId: ROOM_ID,
    projectionKey: "echo.student_approved",
    analysisEpoch: EPOCH,
    baseSnapshot: studentEcho(1),
    patches: [patch],
    truncatedBeforeVersion: 1,
    headVersion: 2,
  });
}

function teacherEcho(): TeacherConceptMapSnapshot {
  return analyticsContract.parseTeacherEchoSnapshot({
    ...goldenEcho,
    payload: {
      ...goldenEcho.payload,
      edges: [{
        ...goldenEcho.payload.edges[0],
        edgeId: EDGE_ID,
        evidenceRefs: [
          { eventId: EVENT_ID, start: 0, end: 4 },
          { eventId: "00000000-0000-4000-8000-000000000703", start: 5, end: 9 },
        ],
      }],
    },
  });
}

const STUDENT_INTERPRETATION = "此圖呈現系統觀測到的近期互動事件，不等同友情、地位、能力、貢獻價值、學習成績、心理關係或 Agent 因果效果。";
const nodes = [
  { nodeId: "p-1111111111111111", label: "探索者 A" as const, kind: "learner" as const },
  { nodeId: "p-2222222222222222", label: "探索者 B" as const, kind: "learner" as const },
];
function studentTrace(version = 1, participationBalance = 0.25, epoch = EPOCH): Extract<SnaProjectionBundle, { projectionKey: "trace.student_bundle" }> {
  const view = (
    metric: number,
    layer: "communication" | "uptake" = "communication",
    warnings: Array<"small_group_interpretation_warning" | "recent_group_interaction_only" | "insufficient_window"> = ["small_group_interpretation_warning"],
  ) => ({
    nodes,
    edges: [{ sourceNodeId: nodes[0]!.nodeId, targetNodeId: nodes[1]!.nodeId, layer }],
    metrics: { participationBalance: metric, reciprocity: 0.5, agentShare: 0, semanticCoverage: 0.75 },
    warnings,
  });
  return analyticsContract.parseTrace({
    schemaVersion: 1,
    projectionKey: "trace.student_bundle",
    roomId: ROOM_ID,
    analysisEpoch: epoch,
    algorithmVersion: "trace-v1",
    parameterHash: "c".repeat(64),
    projectionVersion: version,
    baseVersion: version - 1,
    completeThroughRoomSeq: version + 3,
    watermarkEventTime: "2026-08-30T09:00:00.000Z",
    requiresReplay: false,
    evidenceStatus: "active",
    reviewStatus: "approved",
    displayStatus: "student_aggregate",
    warnings: ["small_group_interpretation_warning"],
    payload: {
      windows: {
        recent_10m: {
          windowStartEventTime: "2026-08-30T08:50:00.000Z",
          windowEndEventTime: "2026-08-30T09:00:00.000Z",
          views: {
            observed: view(participationBalance, "communication", ["small_group_interpretation_warning", "recent_group_interaction_only"]),
            human_only: view(0.4),
            lineage_adjusted: view(0.6, "uptake"),
          },
        },
        session_45m: {
          windowStartEventTime: "2026-08-30T08:15:00.000Z",
          windowEndEventTime: "2026-08-30T09:00:00.000Z",
          views: {
            observed: view(0.7),
            human_only: view(0.8),
            lineage_adjusted: view(0.9, "uptake", ["small_group_interpretation_warning", "insufficient_window"]),
          },
        },
      },
      interpretation: STUDENT_INTERPRETATION,
    },
  }) as Extract<SnaProjectionBundle, { projectionKey: "trace.student_bundle" }>;
}

const ready = (snapshot: NonNullable<ProjectionSlot["snapshot"]>): ProjectionSlot => ({ availability: "ready", snapshot });

afterEach(cleanup);

describe("server projection panels", () => {
  it("renders ECHO graph/list/Inspector parity without exposing student or teacher UUIDs", async () => {
    const user = userEvent.setup();
    const warnedStudent = analyticsContract.parseStudentEchoSnapshot({
      ...studentEcho(),
      warnings: ["client_time_future_clamped"],
    });
    const { container, rerender } = render(<EchoPanel slot={ready(warnedStudent)} onRetry={vi.fn()} />);
    expect(screen.getByRole("status", { name: "分析解讀警告" })).toHaveTextContent("裝置時間超前");
    expect(container.querySelector(".analysis-svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("list", { name: "概念關係等價列表" })).toHaveTextContent("provides energy to");
    const studentEdge = screen.getByRole("button", { name: /sun provides energy to producers/u });
    studentEdge.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("region", { name: "ECHO Inspector" })).toHaveTextContent("provides energy to");
    expect(screen.getByRole("region", { name: "ECHO Inspector" })).toHaveAttribute("aria-live", "polite");
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/iu);
    expect(document.body.textContent).not.toContain("activityScore");

    rerender(<EchoPanel slot={ready(teacherEcho())} onRetry={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /sun provides energy to producers/u }));
    expect(screen.getByRole("region", { name: "ECHO Inspector" })).toHaveTextContent("2 項伺服器證據");
    expect(document.body.textContent).not.toContain(EDGE_ID);
    expect(document.body.textContent).not.toContain(EVENT_ID);
  });

  it("switches TRACE two windows and three views atomically from one generated bundle", async () => {
    const user = userEvent.setup();
    render(<TracePanel slot={ready(studentTrace())} onRetry={vi.fn()} />);
    expect(screen.getByText(STUDENT_INTERPRETATION)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "分析解讀警告" })).toHaveTextContent("近期群體互動");
    expect(screen.getByRole("group", { name: "時間窗口" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "網絡視圖" })).toBeInTheDocument();
    expect(screen.getByRole("definition", { name: "群體參與平衡" })).toHaveTextContent("25%");
    expect(screen.getByRole("list", { name: "互動網絡等價列表" })).toHaveTextContent("communication");

    await user.click(screen.getByRole("button", { name: "全課 45 分鐘" }));
    await user.click(screen.getByRole("button", { name: "承接關係" }));
    expect(screen.getByRole("definition", { name: "群體參與平衡" })).toHaveTextContent("90%");
    expect(screen.getByRole("list", { name: "互動網絡等價列表" })).toHaveTextContent("uptake");
    expect(screen.getByRole("status", { name: "分析解讀警告" })).toHaveTextContent("互動事件不足");
    expect(screen.getByRole("status", { name: "分析解讀警告" })).not.toHaveTextContent("近期群體互動");
    expect(document.body.textContent).not.toContain(nodes[0]!.nodeId);
    expect(document.body.textContent).not.toMatch(/weight|channels|rank|能力分數/iu);

    const lineageEdge = screen.getByRole("button", { name: /探索者 A → 探索者 B/u });
    lineageEdge.focus();
    await user.keyboard(" ");
    expect(screen.getByRole("region", { name: "TRACE Inspector" })).toHaveTextContent("互動層：uptake");
    expect(screen.getByRole("region", { name: "TRACE Inspector" })).toHaveAttribute("aria-live", "polite");
  });

  it("loads a generated ECHO Timeline and previews a reconstructed version without replacing canonical latest", async () => {
    const user = userEvent.setup();
    const loadTimeline = vi.fn(async () => studentTimeline());
    render(<EchoPanel slot={ready(studentEcho(2))} onLoadTimeline={loadTimeline} onRetry={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "查看版本時間線" }));
    expect(await screen.findByRole("region", { name: "ECHO Timeline" })).toHaveTextContent("伺服器 Head：v2");
    expect(screen.getByRole("list", { name: "ECHO 版本時間線" })).toHaveAttribute("tabindex", "0");
    expect(loadTimeline).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "預覽 v1" }));
    expect(screen.getByLabelText("Projection 版本 1")).toHaveTextContent("歷史 v1");
    await user.click(screen.getByRole("button", { name: "返回最新已驗證版本" }));
    expect(screen.getByLabelText("Projection 版本 2")).toHaveTextContent("v2");
  });

  it("pauses presentation while validating newer TRACE versions, then resumes once to latest", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TracePanel slot={ready(studentTrace(1, 0.25))} onRetry={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "暫停圖譜呈現" }));
    rerender(<TracePanel slot={ready(studentTrace(3, 0.85))} onRetry={vi.fn()} />);
    expect(screen.getByRole("definition", { name: "群體參與平衡" })).toHaveTextContent("25%");
    expect(screen.getByText(/2 個較新版本/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "顯示最新已驗證版本" }));
    await waitFor(() => expect(screen.getByRole("definition", { name: "群體參與平衡" })).toHaveTextContent("85%"));
  });

  it("drops ECHO history but keeps TRACE presentation paused across a new Analysis Epoch", async () => {
    const user = userEvent.setup();
    const echo = render(<EchoPanel slot={ready(studentEcho(2))} onLoadTimeline={async () => studentTimeline()} onRetry={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "查看版本時間線" }));
    await user.click(await screen.findByRole("button", { name: "預覽 v1" }));
    expect(screen.getByLabelText("Projection 版本 1")).toHaveTextContent("歷史 v1");
    echo.rerender(<EchoPanel slot={ready(studentEcho(1, NEXT_EPOCH, "新 Epoch 概念"))} onLoadTimeline={async () => studentTimeline()} onRetry={vi.fn()} />);
    expect(screen.getByLabelText("Projection 版本 1")).toHaveTextContent(/^v1$/u);
    expect(screen.getByRole("list", { name: "概念關係等價列表" })).toHaveTextContent("新 Epoch 概念");
    expect(screen.queryByRole("region", { name: "ECHO Timeline" })).not.toBeInTheDocument();
    echo.unmount();

    const trace = render(<TracePanel slot={ready(studentTrace(1, 0.25))} onRetry={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "暫停圖譜呈現" }));
    trace.rerender(<TracePanel slot={ready(studentTrace(1, 0.85, NEXT_EPOCH))} onRetry={vi.fn()} />);
    expect(screen.getByRole("definition", { name: "群體參與平衡" })).toHaveTextContent("25%");
    expect(screen.getByText(/1 個較新版本/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "顯示最新已驗證版本" }));
    expect(screen.getByRole("definition", { name: "群體參與平衡" })).toHaveTextContent("85%");
  });

  it("shows explicit policy and retryable failure states without creating an empty graph", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const { container, rerender } = render(<EchoPanel slot={{ availability: "not_available_by_policy" }} onRetry={retry} />);
    expect(screen.getByRole("status")).toHaveTextContent("not_available_by_policy");
    expect(container.querySelector(".analysis-svg")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新檢查 ECHO 權限" }));
    expect(retry).toHaveBeenCalledTimes(1);

    rerender(<TracePanel slot={{ availability: "failed", errorCode: "ANALYTICS_CORRUPT" }} onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("ANALYTICS_CORRUPT");
    expect(screen.queryByRole("definition", { name: "群體參與平衡" })).not.toBeInTheDocument();
  });
});
