import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  analyticsContract,
  type AnalyticsReviewCommand,
  type DerivedTextArtifact,
} from "@learning-orbit/contracts";
import { SessionGatewayError, type SessionGateway } from "../session/session-gateway.js";
import {
  saveRoomExport,
  TeacherControlPanel,
} from "./teacher-control-panel.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const EPOCH = "00000000-0000-4000-8000-000000000011";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000012";
const EDGE_ID = "00000000-0000-4000-8000-000000000013";
const EVENT_ID = "00000000-0000-4000-8000-000000000014";
const EVENT_ID_2 = "00000000-0000-4000-8000-000000000018";
const REVIEW_ID = "00000000-0000-4000-8000-000000000015";
const REPLAY_ID = "00000000-0000-4000-8000-000000000016";

const echo = analyticsContract.parseTeacherEchoSnapshot({
  schemaVersion: 1,
  projectionKey: "echo.teacher_shadow",
  roomId: ROOM_ID,
  analysisEpoch: EPOCH,
  algorithmVersion: "echo-v1",
  parameterHash: "a".repeat(64),
  projectionVersion: 4,
  baseVersion: 3,
  completeThroughRoomSeq: 8,
  watermarkEventTime: "2026-08-31T01:00:00.000Z",
  requiresReplay: false,
  evidenceStatus: "active",
  reviewStatus: "unreviewed",
  displayStatus: "teacher_shadow",
  warnings: [],
  payload: {
    nodes: [
      { nodeId: "producer", label: "生產者", nodeKind: "concept", evidenceStatus: "supported", reviewStatus: "unreviewed", displayStatus: "provisional", position: { x: 0.25, y: 0.5 } },
      { nodeId: "plant", label: "植物", nodeKind: "concept", evidenceStatus: "supported", reviewStatus: "unreviewed", displayStatus: "provisional", position: { x: 0.75, y: 0.5 } },
    ],
    edges: [{
      edgeId: EDGE_ID,
      head: "producer",
      predicate: "receives energy from",
      tail: "plant",
      relationFamily: "energy_flow",
      evidenceStatus: "supported",
      reviewStatus: "unreviewed",
      displayStatus: "provisional",
      channels: { support: 1, challenge: 0, uncertain: 0, question: 0 },
      activityScore: 1,
      evidenceRefs: [{ eventId: EVENT_ID, start: 0, end: 2 }],
    }],
  },
});

const artifact: DerivedTextArtifact = {
  schemaVersion: 1,
  artifactId: ARTIFACT_ID,
  lineageId: "00000000-0000-4000-8000-000000000017",
  roomId: ROOM_ID,
  eventId: EVENT_ID,
  roomSeq: 3,
  sourceMediaId: null,
  sourceModality: "text",
  derivation: "direct",
  text: "太陽提供能量給生產者。",
  normalizedTextSha256: "b".repeat(64),
  sourceConfidenceRaw: 1,
  sourceConfidenceCalibrated: null,
  provider: "learner-authored",
  modelVersion: "direct-text-v1",
  languageTag: "zh-Hant",
  spans: [],
  reviewStatus: "unreviewed",
  displayStatus: "teacher_shadow",
  warnings: [],
  supersedesArtifactId: null,
  active: true,
  createdAt: "2026-08-31T01:00:00.000Z",
};

function gateway(overrides: Partial<SessionGateway> = {}) {
  return {
    getDerivedTextArtifacts: vi.fn(async () => ({ items: [artifact], throughRoomSeq: 3, nextAfterArtifactId: null, includeHistory: false })),
    submitAnalyticsReview: vi.fn(async (_roomId: string, input: AnalyticsReviewCommand) => ({
      schemaVersion: 1 as const,
      reviewEventId: REVIEW_ID,
      changeKind: "correctionKind" in input ? "correction" as const : "review" as const,
      replayJobId: REPLAY_ID,
    })),
    exportRoom: vi.fn(async () => ({ blob: new Blob(["[]"], { type: "application/json" }), fileName: "learning-orbit-room-export.json", format: "json" as const })),
    requestRoomDeletion: vi.fn(async () => ({ deletionJobId: REVIEW_ID, status: "queued" as const })),
    getRoomDeletion: vi.fn(async () => { throw new Error("ROOM_NOT_FOUND"); }),
    setAgentSettings: vi.fn(async (_roomId: string, input) => ({ enabled: input.enabled, cancelledRunId: null })),
    getAnalyticsReviewDetail: vi.fn(async () => ({
      schemaVersion: 1 as const,
      reviewEventId: REVIEW_ID,
      roomId: ROOM_ID,
      changeKind: "correction" as const,
      payload: {
        targetCanonicalNodeId: "producer",
        correctionKind: "merge_alias" as const,
        replacement: { aliasNodeId: "plant" },
        reason: "合併同義概念。",
        expectedAnalysisEpoch: EPOCH,
        expectedProjectionVersion: 4,
      },
      createdAt: "2026-08-31T01:00:00.000Z",
    })),
    ...overrides,
  } as Pick<SessionGateway, "getDerivedTextArtifacts" | "submitAnalyticsReview" | "exportRoom" | "requestRoomDeletion" | "getRoomDeletion" | "setAgentSettings" | "getAnalyticsReviewDetail">;
}

describe("teacher control panel", () => {
  afterEach(cleanup);

  it("sends lifecycle commands without predicting a new room state", async () => {
    const runtime = {
      sendIntent: vi.fn(() => REVIEW_ID),
      sessionState: { connected: true },
      pendingCommandIds: vi.fn(() => [REVIEW_ID]),
      acks: new Map<string, unknown>(),
      rejects: [],
    };
    render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="scheduled" echo={echo} gateway={gateway()} runtime={runtime} onDeletionAccepted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "開始課堂" }));
    expect(runtime.sendIntent).toHaveBeenCalledWith({ type: "room.open" });
    expect(screen.getByText("指令已進入可靠佇列，等待伺服器 ACK。")).toBeInTheDocument();
  });

  it("explains that one-time room and seat codes cannot be recovered from the room page", () => {
    render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="scheduled" echo={echo} gateway={gateway()} runtime={{ sendIntent: vi.fn(() => REVIEW_ID), sessionState: { connected: true } }} onDeletionAccepted={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "一次性邀請碼" })).toBeInTheDocument();
    expect(screen.getByText(/Room Code 與四個 Seat Code 只會在建立課堂成功時顯示一次/u)).toBeInTheDocument();
    expect(screen.getByText(/若尚未分發而代碼已遺失，請結束此課堂並建立新課堂/u)).toBeInTheDocument();
  });

  it("disables lifecycle controls while WSS authority is unavailable", async () => {
    const runtime = { sendIntent: vi.fn(() => REVIEW_ID), sessionState: { connected: false } };
    render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="scheduled" echo={echo} gateway={gateway()} runtime={runtime} onDeletionAccepted={vi.fn()} />);
    expect(screen.getByRole("button", { name: "開始課堂" })).toBeDisabled();
    expect(screen.getByText("WebSocket 尚未連線；課堂生命週期控制保持停用。")).toBeInTheDocument();
    expect(runtime.sendIntent).not.toHaveBeenCalled();
  });

  it("keeps lifecycle controls locked after ACK until a RoomEvent changes status", async () => {
    const sendIntent = vi.fn(() => REVIEW_ID);
    const baseRuntime = { sendIntent, sessionState: { connected: true }, pendingCommandIds: () => [REVIEW_ID], acks: new Map<string, unknown>(), rejects: [] };
    const api = gateway();
    const { rerender } = render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="scheduled" echo={echo} gateway={api} runtime={baseRuntime} onDeletionAccepted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "開始課堂" }));

    rerender(<TeacherControlPanel roomId={ROOM_ID} roomStatus="scheduled" echo={echo} gateway={api} runtime={{ ...baseRuntime, pendingCommandIds: () => [], acks: new Map([[REVIEW_ID, {}]]) }} onDeletionAccepted={vi.fn()} />);
    expect(screen.getByText("伺服器已 ACK，等待 RoomEvent 確認狀態。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "開始課堂" })).toBeDisabled();

    rerender(<TeacherControlPanel roomId={ROOM_ID} roomStatus="open" echo={echo} gateway={api} runtime={{ ...baseRuntime, pendingCommandIds: () => [], acks: new Map([[REVIEW_ID, {}]]) }} onDeletionAccepted={vi.fn()} />);
    expect(screen.getByText("伺服器 RoomEvent 已確認新的課堂狀態。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暫停課堂" })).toBeEnabled();
  });

  it("keeps a retryable lifecycle reject locked but releases a terminal reject", async () => {
    const sendIntent = vi.fn(() => REVIEW_ID);
    const api = gateway();
    const runtime = { sendIntent, sessionState: { connected: true }, pendingCommandIds: () => [REVIEW_ID], acks: new Map<string, unknown>(), rejects: [] };
    const { rerender } = render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="scheduled" echo={echo} gateway={api} runtime={runtime} onDeletionAccepted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "開始課堂" }));

    rerender(<TeacherControlPanel roomId={ROOM_ID} roomStatus="scheduled" echo={echo} gateway={api} runtime={{ ...runtime, rejects: [{ commandId: REVIEW_ID, code: "INTERNAL", retryable: true }] }} onDeletionAccepted={vi.fn()} />);
    expect(screen.getByText(/原指令仍在可靠佇列/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "開始課堂" })).toBeDisabled();

    rerender(<TeacherControlPanel roomId={ROOM_ID} roomStatus="scheduled" echo={echo} gateway={api} runtime={{ ...runtime, pendingCommandIds: () => [], rejects: [{ commandId: REVIEW_ID, code: "FORBIDDEN", retryable: false }] }} onDeletionAccepted={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("FORBIDDEN");
    expect(screen.getByRole("button", { name: "開始課堂" })).toBeEnabled();
  });

  it("changes Nova policy only after the generated server settings response", async () => {
    const api = gateway();
    const runtime = { sendIntent: vi.fn(() => REVIEW_ID), refreshAgentCurrent: vi.fn(async () => undefined) };
    const rendered = render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="open" echo={echo} agentEnabled={true} gateway={api} runtime={runtime} onDeletionAccepted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "停用 Nova" }));
    await waitFor(() => expect(api.setAgentSettings).toHaveBeenCalledWith(
      ROOM_ID,
      { enabled: false },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(runtime.refreshAgentCurrent).toHaveBeenCalledOnce();
    expect(await screen.findByText(/伺服器已停用 Nova 政策/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "啟用 Nova" })).toBeEnabled();

    rendered.unmount();
    const refreshAgentCurrent = vi.fn(async () => { throw new Error("CURRENT_UNAVAILABLE"); });
    render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="open" echo={echo} agentEnabled={true} gateway={gateway()} runtime={{ sendIntent: vi.fn(() => REVIEW_ID), refreshAgentCurrent }} onDeletionAccepted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "停用 Nova" }));
    expect(await screen.findByText(/伺服器已停用 Nova 政策，但最新 Agent 狀態暫時無法刷新/u)).toBeInTheDocument();
    expect(screen.queryByText(/Nova 政策未更新/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "啟用 Nova" })).toBeEnabled();
  });

  it("hands AUTH_REQUIRED to the room owner so memory and WSS can be cleared", async () => {
    const api = gateway({
      setAgentSettings: vi.fn(async () => { throw new SessionGatewayError("AUTH_REQUIRED"); }),
    });
    const onSessionExpired = vi.fn();
    render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="open" echo={echo} agentEnabled={true} gateway={api} runtime={{ sendIntent: vi.fn(() => REVIEW_ID) }} onDeletionAccepted={vi.fn()} onSessionExpired={onSessionExpired} />);
    await userEvent.click(screen.getByRole("button", { name: "停用 Nova" }));
    await waitFor(() => expect(onSessionExpired).toHaveBeenCalledOnce());
    expect(screen.queryByText(/Nova 政策未更新/u)).not.toBeInTheDocument();
  });

  it("moves keyboard focus to a teacher action error", async () => {
    const api = gateway({
      setAgentSettings: vi.fn(async () => { throw new Error("AGENT_SETTINGS_UNAVAILABLE"); }),
    });
    render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="open" echo={echo} agentEnabled={true} gateway={api} runtime={{ sendIntent: vi.fn(() => REVIEW_ID) }} onDeletionAccepted={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "停用 Nova" }));
    const error = await screen.findByRole("alert", { name: "" });

    expect(error).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expect(error).toHaveFocus());
  });

  it("aborts an in-flight teacher mutation when the room control unmounts", async () => {
    let signal: AbortSignal | undefined;
    const setAgentSettings = vi.fn(async (_roomId, _input, options) => {
      signal = options?.signal;
      await new Promise(() => undefined);
      return { enabled: false, cancelledRunId: null };
    });
    const api = gateway({ setAgentSettings });
    const rendered = render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="open" echo={echo} agentEnabled={true} gateway={api} runtime={{ sendIntent: vi.fn(() => REVIEW_ID) }} onDeletionAccepted={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "停用 Nova" }));
    await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
    rendered.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("submits an artifact review with the exact server ECHO epoch/version and keeps UUIDs out of the DOM", async () => {
    const api = gateway();
    render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="open" echo={echo} gateway={api} runtime={{ sendIntent: vi.fn(() => REVIEW_ID) }} onDeletionAccepted={vi.fn()} />);
    expect(await screen.findByText(artifact.text)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("審閱理由"), "證據與原始文字一致。");
    await userEvent.click(screen.getByRole("button", { name: "提交審閱" }));

    expect(api.submitAnalyticsReview).toHaveBeenCalledWith(ROOM_ID, {
      targetType: "derived_text",
      targetId: ARTIFACT_ID,
      decision: "approve",
      rationale: "證據與原始文字一致。",
      expectedAnalysisEpoch: EPOCH,
      expectedProjectionVersion: 4,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(await screen.findByText(/審閱已記錄/u)).toBeInTheDocument();
    expect(screen.getByText(/這個 Projection Authority 已提交一個事實/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交審閱" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "提交修正" })).toBeDisabled();
    for (const id of [ROOM_ID, EPOCH, ARTIFACT_ID, EDGE_ID, EVENT_ID, REVIEW_ID, REPLAY_ID]) {
      expect(document.body.innerHTML).not.toContain(id);
    }
  });

  it("offers all seven generated correction branches and uses the accepted merge identity only in memory for undo", async () => {
    const api = gateway();
    const runtime = { sendIntent: vi.fn(() => REVIEW_ID) };
    const { rerender } = render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="open" echo={echo} gateway={api} runtime={runtime} onDeletionAccepted={vi.fn()} />);
    await screen.findByText(artifact.text);
    const branch = screen.getByLabelText("修正分支");
    for (const label of ["修正文字", "替換證據片段", "修正概念關係", "合併同義概念", "拆分同義概念", "撤銷本次合併", "撤回分析目標"]) {
      expect(branch).toHaveTextContent(label);
    }

    await userEvent.type(screen.getByLabelText("修正理由"), "先檢查分支必填欄位。");
    expect(screen.getByRole("button", { name: "提交修正" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("替換文字"), "修正後的文字");
    expect(screen.getByRole("button", { name: "提交修正" })).toBeEnabled();

    await userEvent.selectOptions(branch, "merge_alias");
    await userEvent.click(screen.getByRole("button", { name: "提交修正" }));
    await waitFor(() => expect(api.submitAnalyticsReview).toHaveBeenCalledTimes(1));

    expect(screen.getByText(/這個 Projection Authority 已提交一個事實/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交修正" })).toBeDisabled();

    const mergedEcho = analyticsContract.parseTeacherEchoSnapshot({
      ...echo,
      projectionVersion: 5,
      baseVersion: 4,
      payload: { nodes: [echo.payload.nodes[0]], edges: [] },
    });
    rerender(<TeacherControlPanel roomId={ROOM_ID} roomStatus="open" echo={mergedEcho} gateway={api} runtime={runtime} onDeletionAccepted={vi.fn()} />);
    const replayBranch = screen.getByLabelText("修正分支");
    await waitFor(() => expect(replayBranch).toBeEnabled());
    await userEvent.selectOptions(replayBranch, "undo_merge");
    expect(await screen.findByText(/新 Projection 已確認合併生效/u)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("修正理由"), "重新檢查後應保持分開。");
    await userEvent.click(screen.getByRole("button", { name: "提交修正" }));
    await waitFor(() => expect(api.submitAnalyticsReview).toHaveBeenCalledTimes(2));
    expect(api.submitAnalyticsReview).toHaveBeenLastCalledWith(ROOM_ID, expect.objectContaining({
      correctionKind: "undo_merge",
      targetCorrectionEventId: REVIEW_ID,
      expectedAnalysisEpoch: EPOCH,
      expectedProjectionVersion: 5,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(document.body.innerHTML).not.toContain(REVIEW_ID);
  });

  it("selects the exact evidence span instead of silently using the first reference", async () => {
    const multiEvidence = analyticsContract.parseTeacherEchoSnapshot({
      ...echo,
      payload: {
        ...echo.payload,
        edges: [{
          ...echo.payload.edges[0],
          evidenceRefs: [
            { eventId: EVENT_ID, start: 0, end: 2 },
            { eventId: EVENT_ID_2, start: 3, end: 7 },
          ],
        }],
      },
    });
    const api = gateway();
    render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="open" echo={multiEvidence} gateway={api} runtime={{ sendIntent: vi.fn(() => REVIEW_ID) }} onDeletionAccepted={vi.fn()} />);
    await screen.findByText(artifact.text);
    await userEvent.selectOptions(screen.getByLabelText("修正分支"), "replace_evidence_span");
    await userEvent.selectOptions(screen.getByLabelText("原證據片段"), "1");
    await userEvent.selectOptions(screen.getByLabelText("替換證據片段"), "0");
    await userEvent.type(screen.getByLabelText("修正理由"), "選擇正確的伺服器文字片段。");
    await userEvent.click(screen.getByRole("button", { name: "提交修正" }));

    await waitFor(() => expect(api.submitAnalyticsReview).toHaveBeenCalledWith(ROOM_ID, expect.objectContaining({
      correctionKind: "replace_evidence_span",
      target: { eventId: EVENT_ID_2, start: 3, end: 7 },
      replacement: { eventId: EVENT_ID, start: 0, end: 2 },
    }), expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });

  it("restores the latest effective merge from server review detail after a page refresh", async () => {
    const mergedEcho = analyticsContract.parseTeacherEchoSnapshot({
      ...echo,
      projectionVersion: 5,
      baseVersion: 4,
      payload: { nodes: [echo.payload.nodes[0]], edges: [] },
    });
    const api = gateway();
    render(<TeacherControlPanel
      roomId={ROOM_ID}
      roomStatus="open"
      echo={mergedEcho}
      analyticsCorrectionEventIds={[REVIEW_ID]}
      gateway={api}
      runtime={{ sendIntent: vi.fn(() => REVIEW_ID) }}
      onDeletionAccepted={vi.fn()}
    />);
    await waitFor(() => expect(api.getAnalyticsReviewDetail).toHaveBeenCalledWith(
      ROOM_ID,
      REVIEW_ID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    const restoredBranch = screen.getByLabelText("修正分支");
    await waitFor(() => expect(restoredBranch).toBeEnabled());
    await userEvent.selectOptions(restoredBranch, "undo_merge");
    expect(await screen.findByText(/新 Projection 已確認合併生效/u)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(REVIEW_ID);
    await userEvent.type(screen.getByLabelText("修正理由"), "重新檢查後應保持分開。");
    await userEvent.click(screen.getByRole("button", { name: "提交修正" }));
    await waitFor(() => expect(api.submitAnalyticsReview).toHaveBeenCalledWith(ROOM_ID, expect.objectContaining({
      correctionKind: "undo_merge",
      targetCorrectionEventId: REVIEW_ID,
      expectedProjectionVersion: 5,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });

  it("invalidates a restored merge before resolving a newer correction detail", async () => {
    const mergedEcho = analyticsContract.parseTeacherEchoSnapshot({
      ...echo,
      projectionVersion: 5,
      baseVersion: 4,
      payload: { nodes: [echo.payload.nodes[0]], edges: [] },
    });
    const detail = gateway().getAnalyticsReviewDetail;
    const getAnalyticsReviewDetail = vi.fn()
      .mockImplementationOnce(detail)
      .mockRejectedValueOnce(new Error("DETAIL_UNAVAILABLE"));
    const api = gateway({ getAnalyticsReviewDetail });
    const props = {
      roomId: ROOM_ID,
      roomStatus: "open" as const,
      echo: mergedEcho,
      gateway: api,
      runtime: { sendIntent: vi.fn(() => REVIEW_ID) },
      onDeletionAccepted: vi.fn(),
    };
    const { rerender } = render(<TeacherControlPanel {...props} analyticsCorrectionEventIds={[REVIEW_ID]} />);
    const restoredBranch = screen.getByLabelText("修正分支");
    await waitFor(() => expect(restoredBranch).toBeEnabled());
    await userEvent.selectOptions(restoredBranch, "undo_merge");
    expect(await screen.findByText(/新 Projection 已確認合併生效/u)).toBeInTheDocument();

    rerender(<TeacherControlPanel {...props} analyticsCorrectionEventIds={[REVIEW_ID, EVENT_ID_2]} />);
    await waitFor(() => expect(getAnalyticsReviewDetail).toHaveBeenLastCalledWith(
      ROOM_ID,
      EVENT_ID_2,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(await screen.findByText(/尚沒有可撤銷的伺服器合併記錄/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交修正" })).toBeDisabled();
  });

  it("clears target indices and drafts when server Projection Authority changes", async () => {
    let resolveNewAuthorityQueue: ((page: {
      items: DerivedTextArtifact[];
      throughRoomSeq: number;
      nextAfterArtifactId: null;
      includeHistory: false;
    }) => void) | undefined;
    const getDerivedTextArtifacts = vi.fn()
      .mockResolvedValueOnce({ items: [artifact], throughRoomSeq: 3, nextAfterArtifactId: null, includeHistory: false })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNewAuthorityQueue = resolve; }));
    const api = gateway({ getDerivedTextArtifacts });
    const runtime = { sendIntent: vi.fn(() => REVIEW_ID) };
    const { rerender } = render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="open" echo={echo} gateway={api} runtime={runtime} onDeletionAccepted={vi.fn()} />);
    await screen.findByText(artifact.text);
    await userEvent.selectOptions(screen.getByLabelText("修正分支"), "merge_alias");
    await userEvent.type(screen.getByLabelText("修正理由"), "這段草稿綁定舊版本。");

    const nextEcho = analyticsContract.parseTeacherEchoSnapshot({
      ...echo,
      projectionVersion: 5,
      baseVersion: 4,
      payload: { ...echo.payload, nodes: [...echo.payload.nodes].reverse() },
    });
    rerender(<TeacherControlPanel roomId={ROOM_ID} roomStatus="open" echo={nextEcho} gateway={api} runtime={runtime} onDeletionAccepted={vi.fn()} />);

    expect(screen.getByRole("button", { name: "提交審閱" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "提交修正" })).toBeDisabled();
    expect(api.submitAnalyticsReview).not.toHaveBeenCalled();
    resolveNewAuthorityQueue?.({ items: [artifact], throughRoomSeq: 3, nextAfterArtifactId: null, includeHistory: false });
    await waitFor(() => expect(screen.getByLabelText("修正理由")).toHaveValue(""));
    expect(screen.getByText(/Projection Authority 已更新/u)).toBeInTheDocument();
    expect(api.submitAnalyticsReview).not.toHaveBeenCalled();
  });

  it("requires the local confirmation phrase and passes only the server acceptance to deletion recovery", async () => {
    const accepted = { deletionJobId: REVIEW_ID, status: "queued" as const };
    const api = gateway({ requestRoomDeletion: vi.fn(async () => accepted) });
    const onDeletionAccepted = vi.fn();
    render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="closed" echo={echo} gateway={api} runtime={{ sendIntent: vi.fn(() => REVIEW_ID) }} onDeletionAccepted={onDeletionAccepted} />);
    const button = screen.getByRole("button", { name: "要求刪除" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText("確認文字"), "刪除課堂");
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() => expect(onDeletionAccepted).toHaveBeenCalledWith(accepted));
    expect(api.requestRoomDeletion).toHaveBeenCalledWith(
      ROOM_ID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(document.body.innerHTML).not.toContain(REVIEW_ID);
  });

  it("recovers a committed deletion job when the original response is lost", async () => {
    const recovered = { deletionJobId: REVIEW_ID, status: "running" as const, nextPollAfterMs: 1000, failureCode: null };
    const api = gateway({
      requestRoomDeletion: vi.fn(async () => { throw new Error("RESPONSE_LOST"); }),
      getRoomDeletion: vi.fn(async () => recovered),
    });
    const onDeletionAccepted = vi.fn();
    render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="closed" echo={echo} gateway={api} runtime={{ sendIntent: vi.fn(() => REVIEW_ID) }} onDeletionAccepted={onDeletionAccepted} />);
    await userEvent.type(screen.getByLabelText("確認文字"), "刪除課堂");
    await userEvent.click(screen.getByRole("button", { name: "要求刪除" }));
    await waitFor(() => expect(onDeletionAccepted).toHaveBeenCalledWith(recovered));
    expect(api.getRoomDeletion).toHaveBeenCalledWith(
      ROOM_ID,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.queryByText(/未被伺服器接受/u)).not.toBeInTheDocument();
  });

  it("keeps all room mutations locked and enters recovery-only mode when deletion outcome stays unknown", async () => {
    const api = gateway({
      requestRoomDeletion: vi.fn(async () => { throw new Error("RESPONSE_LOST"); }),
      getRoomDeletion: vi.fn(async () => { throw new Error("TRANSIENT_RECOVERY_FAILURE"); }),
    });
    const onDeletionUncertain = vi.fn();
    const runtime = { sendIntent: vi.fn(() => REVIEW_ID), sessionState: { connected: true } };
    render(<TeacherControlPanel roomId={ROOM_ID} roomStatus="open" echo={echo} agentEnabled={true} gateway={api} runtime={runtime} onDeletionAccepted={vi.fn()} onDeletionUncertain={onDeletionUncertain} />);
    await userEvent.type(screen.getByLabelText("確認文字"), "刪除課堂");
    await userEvent.click(screen.getByRole("button", { name: "要求刪除" }));
    await waitFor(() => expect(onDeletionUncertain).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "暫停課堂" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下載 JSON" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "停用 Nova" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("課堂操作保持鎖定");
  });

  it("always revokes the temporary Object URL, including a failed browser click", () => {
    const revokeObjectURL = vi.fn();
    expect(() => saveRoomExport(
      { blob: new Blob(["[]"]), fileName: "learning-orbit-room-export.json", format: "json" },
      {
        createObjectURL: vi.fn(() => "blob:temporary"),
        revokeObjectURL,
        click: vi.fn(() => { throw new Error("CLICK_FAILED"); }),
      },
    )).toThrow("CLICK_FAILED");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:temporary");
  });
});
