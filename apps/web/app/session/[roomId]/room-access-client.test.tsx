import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  analyticsContract,
  type AuthSession,
  type RoomDetails,
  type StudentConceptMapSnapshot,
} from "@learning-orbit/contracts";
import goldenEcho from "../../../../../packages/test-fixtures/analytics/golden-echo-projection.json" with { type: "json" };
import goldenTrace from "../../../../../packages/test-fixtures/analytics/golden-trace-projections.json" with { type: "json" };
import type { SessionGateway } from "../../../src/lib/session/session-gateway.js";
import { SessionGatewayError } from "../../../src/lib/session/session-gateway.js";
import { RoomAccessClient } from "./room-access-client.js";

const replace = vi.fn();
const router = { replace };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const roomId = "00000000-0000-4000-8000-000000000010";
const otherRoomId = "00000000-0000-4000-8000-000000000099";

const teacher: Extract<AuthSession, { role: "teacher" }> = {
  role: "teacher",
  teacherId: "00000000-0000-4000-8000-000000000001",
  actorId: "00000000-0000-4000-8000-000000000001",
};

const student: Extract<AuthSession, { role: "student" }> = {
  role: "student",
  roomId,
  roomMemberId: "00000000-0000-4000-8000-000000000011",
  actorId: "00000000-0000-4000-8000-000000000012",
  pseudonym: "探索者 A",
  nova: {
    actorId: "00000000-0000-4000-8000-000000000013",
    actorKind: "agent",
    actorRole: "socratic_facilitator",
    displayName: "Nova Agent",
  },
};

const room: RoomDetails = {
  roomId,
  topic: "生態系統探究",
  status: "scheduled",
  durationSeconds: 2700,
  startsAt: null,
  closesAt: null,
  nova: student.nova,
  participants: [
    { actorId: student.actorId, pseudonym: "探索者 A", actorKind: "human", actorRole: "student" },
    { actorId: "00000000-0000-4000-8000-000000000014", pseudonym: "探索者 B", actorKind: "human", actorRole: "student" },
    { actorId: "00000000-0000-4000-8000-000000000015", pseudonym: "探索者 C", actorKind: "human", actorRole: "student" },
    { actorId: "00000000-0000-4000-8000-000000000016", pseudonym: "探索者 D", actorKind: "human", actorRole: "student" },
  ],
};

function studentEcho(): StudentConceptMapSnapshot {
  return analyticsContract.parseStudentEchoSnapshot({
    ...goldenEcho,
    projectionKey: "echo.student_approved",
    reviewStatus: "approved",
    displayStatus: "student_approved",
    payload: {
      nodes: goldenEcho.payload.nodes.map((node) => ({ ...node, reviewStatus: "approved" })),
      edges: goldenEcho.payload.edges.map(({ channels: _channels, activityScore: _score, evidenceRefs: _refs, ...edge }) => ({
        ...edge,
        reviewStatus: "approved",
      })),
    },
  });
}

function studentTrace() {
  const observedNodes = [
    { nodeId: "p-1111111111111111", label: "探索者 A" as const, kind: "learner" as const },
    { nodeId: "p-2222222222222222", label: "探索者 B" as const, kind: "learner" as const },
  ];
  const observed = {
    nodes: observedNodes,
    edges: [{ sourceNodeId: observedNodes[0]!.nodeId, targetNodeId: observedNodes[1]!.nodeId, layer: "communication" as const }],
    metrics: { participationBalance: 0.5, reciprocity: 0.25, agentShare: 0, semanticCoverage: 0.75 },
    warnings: ["small_group_interpretation_warning" as const],
  };
  const lineageAdjusted = {
    ...observed,
    edges: [{ sourceNodeId: observedNodes[0]!.nodeId, targetNodeId: observedNodes[1]!.nodeId, layer: "uptake" as const }],
  };
  return analyticsContract.parseTrace({
    ...goldenTrace.student,
    payload: {
      ...goldenTrace.student.payload,
      windows: {
        recent_10m: { ...goldenTrace.student.payload.windows.recent_10m, views: { observed, human_only: observed, lineage_adjusted: lineageAdjusted } },
        session_45m: { ...goldenTrace.student.payload.windows.session_45m, views: { observed, human_only: observed, lineage_adjusted: lineageAdjusted } },
      },
    },
  });
}

function messageEventFrame(roomSeq: number) {
  return {
    type: "event" as const,
    event: {
      eventId: `00000000-0000-4000-8001-${String(roomSeq).padStart(12, "0")}`,
      schemaVersion: 1 as const,
      roomId,
      roomSeq,
      type: "message.added",
      actorId: student.actorId,
      actorKind: "human" as const,
      actorRole: "student" as const,
      revision: 1,
      operation: "add" as const,
      eventTime: "2026-08-30T09:00:00.000Z",
      ingestTime: "2026-08-30T09:00:01.000Z",
      causationId: "00000000-0000-4000-8000-000000000201",
      correlationId: "00000000-0000-4000-8000-000000000401",
      payload: {
        messageId: "00000000-0000-4000-8000-000000000501",
        text: "真實訊息",
        replyTo: null,
        mentions: [],
        mediaIds: [],
      },
    },
  };
}

function gateway(session: AuthSession = student, overrides: Partial<SessionGateway> = {}): SessionGateway {
  return {
    getSession: vi.fn(async () => session),
    joinStudent: vi.fn(async () => student),
    requestTeacherMagicLink: vi.fn(async () => ({ accepted: true as const })),
    getTeacherRooms: vi.fn(async () => ({ rooms: [], truncated: false })),
    createRoom: vi.fn(async () => { throw new SessionGatewayError("ROOM_SERVICE_UNAVAILABLE"); }),
    getRoom: vi.fn(async () => room),
    getRoomEvents: vi.fn(async () => ({ events: [], throughRoomSeq: 0 })),
    createMediaUpload: vi.fn(async () => { throw new SessionGatewayError("MEDIA_SERVICE_UNAVAILABLE"); }),
    completeMediaUpload: vi.fn(async () => { throw new SessionGatewayError("MEDIA_SERVICE_UNAVAILABLE"); }),
    getMedia: vi.fn(async () => { throw new SessionGatewayError("MEDIA_SERVICE_UNAVAILABLE"); }),
    getMediaDownloadGrant: vi.fn(async () => { throw new SessionGatewayError("MEDIA_SERVICE_UNAVAILABLE"); }),
    getAgentCurrent: vi.fn(async (requestedRoomId: string) => ({
      roomId: requestedRoomId,
      run: null,
      serviceHealth: "unavailable" as const,
      agentEnabled: false,
      updatedAt: "2026-08-31T01:00:00.000Z",
    })),
    getProjectionLatest: vi.fn(async () => { throw new SessionGatewayError("ANALYTICS_NOT_READY"); }),
    getProjectionPatches: vi.fn(async () => { throw new SessionGatewayError("ANALYTICS_NOT_READY"); }),
    getConceptTimeline: vi.fn(async () => { throw new SessionGatewayError("ANALYTICS_NOT_READY"); }),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("room route access guard", () => {
  afterEach(() => {
    cleanup();
    replace.mockReset();
    vi.unstubAllGlobals();
  });

  it("hydrates a same-room student only after server room confirmation", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const api = gateway();
    render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} />);
    expect(await screen.findByRole("heading", { name: "生態系統探究" })).toBeInTheDocument();
    expect(screen.getByText("探索者 A")).toBeInTheDocument();
    expect(api.getRoom).toHaveBeenCalledWith(roomId);
    expect(api.getAgentCurrent).toHaveBeenCalledWith(roomId, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(api.getRoomEvents).toHaveBeenCalledWith(roomId, 0, 500);
    expect(screen.getByText(/已按伺服器 roomSeq 同步 0 個 RoomEvent/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/本地演示|模擬即時|太陽是生態系統/);
  });

  it("renders only the student's server-approved ECHO and aggregate TRACE projections", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const getProjectionLatest = vi.fn(async (_requestedRoomId: string, key: string) => {
      if (key === "echo.student_approved") return studentEcho();
      if (key === "trace.student_bundle") return studentTrace();
      throw new SessionGatewayError("PROJECTION_FORBIDDEN");
    });
    const api = gateway(student, { getProjectionLatest });
    render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} />);

    expect(await screen.findByRole("list", { name: "概念關係等價列表" })).toHaveTextContent("provides energy to");
    expect(await screen.findByRole("definition", { name: "群體參與平衡" })).toHaveTextContent("50%");
    expect(screen.getByLabelText("輸入訊息")).toBeInTheDocument();
    expect(getProjectionLatest).toHaveBeenCalledWith(roomId, "echo.student_approved", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(getProjectionLatest).toHaveBeenCalledWith(roomId, "trace.student_bundle", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(getProjectionLatest).not.toHaveBeenCalledWith(roomId, "echo.teacher_shadow", expect.anything());
    expect(document.body.textContent).not.toMatch(/activityScore|evidenceRefs|能力分數\s*[:：]|個人排名\s*[:：]/iu);
  });

  it("keeps chat and the other projection available when one student projection is denied by policy", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const api = gateway(student, {
      getProjectionLatest: vi.fn(async (_requestedRoomId: string, key: string) => {
        if (key === "echo.student_approved") throw new SessionGatewayError("STUDENT_ANALYTICS_NOT_PROMOTED");
        return studentTrace();
      }),
    });
    render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} />);

    expect(await screen.findByText(/not_available_by_policy/u)).toBeInTheDocument();
    expect(await screen.findByRole("definition", { name: "群體參與平衡" })).toHaveTextContent("50%");
    expect(screen.getByLabelText("輸入訊息")).toBeInTheDocument();
  });

  it("keeps text chat available while the Agent status endpoint fails closed", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const api = gateway(student, {
      getAgentCurrent: vi.fn(async () => { throw new SessionGatewayError("AGENT_SERVICE_UNAVAILABLE"); }),
    });
    render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} />);
    expect(await screen.findByRole("heading", { name: "生態系統探究" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Agent 狀態目前無法確認");
    expect(screen.getByLabelText("輸入訊息")).toBeInTheDocument();
  });

  it("bounds a stalled Agent status request and aborts it without blocking text chat", async () => {
    vi.stubGlobal("WebSocket", undefined);
    let requestSignal: AbortSignal | undefined;
    const api = gateway(student, {
      getAgentCurrent: vi.fn(async (_requestedRoomId: string, options?: { signal?: AbortSignal }) => {
        requestSignal = options?.signal;
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }),
    });
    render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} agentStatusTimeoutMs={100} />);
    expect(await screen.findByRole("heading", { name: "生態系統探究" }, { timeout: 500 })).toBeInTheDocument();
    expect(requestSignal?.aborted).toBe(false);
    expect(screen.getByText(/正在向伺服器確認 Nova 狀態/u)).toBeInTheDocument();
    expect(await screen.findByText(/Agent 狀態目前無法確認/u, {}, { timeout: 500 })).toBeInTheDocument();
    expect(requestSignal?.aborted).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent("Agent 狀態目前無法確認");
    expect(screen.getByLabelText("輸入訊息")).toBeInTheDocument();
  });

  it("aborts the Agent status request when the room route is disposed", async () => {
    vi.stubGlobal("WebSocket", undefined);
    let requestSignal: AbortSignal | undefined;
    const api = gateway(student, {
      getAgentCurrent: vi.fn(async (_requestedRoomId: string, options?: { signal?: AbortSignal }) => {
        requestSignal = options?.signal;
        return await new Promise<never>(() => undefined);
      }),
    });
    const { unmount } = render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} agentStatusTimeoutMs={10_000} />);
    await waitFor(() => expect(api.getAgentCurrent).toHaveBeenCalledOnce());
    unmount();
    expect(requestSignal?.aborted).toBe(true);
  });

  it("renders only confirmed chat events and keeps a newly sent command pending until server delivery", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000202" });
    const confirmed = messageEventFrame(1).event;
    const api = gateway(student, {
      getRoom: vi.fn(async () => ({ ...room, status: "open" as const, startsAt: "2026-08-30T09:00:00.000Z", closesAt: "2026-08-30T09:45:00.000Z" })),
      getRoomEvents: vi.fn(async () => ({ events: [confirmed], throughRoomSeq: 1 })),
    });
    render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} />);
    expect(await screen.findByText("真實訊息")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(confirmed.eventId);
    expect(document.body.innerHTML).not.toContain(confirmed.payload.messageId);
    expect(document.body.innerHTML).not.toContain(student.actorId);
    await userEvent.type(screen.getByLabelText("輸入訊息"), "待確認的新訊息");
    await userEvent.click(screen.getByRole("button", { name: "發送訊息" }));
    expect(screen.queryByText("待確認的新訊息")).not.toBeInTheDocument();
    expect(screen.getByText(/1 個指令正在等待伺服器 ACK/)).toBeInTheDocument();
  });

  it("subscribes before native connect so an immediate confirmed frame is rendered", async () => {
    class ImmediateWebSocket {
      readonly readyState = 0;
      send() {}
      close() {}
      addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
        if (type === "message") listener({ data: JSON.stringify(messageEventFrame(1)) });
      }
    }
    vi.stubGlobal("WebSocket", ImmediateWebSocket);
    render(<RoomAccessClient gateway={gateway()} mode="student" roomId={roomId} />);
    expect(await screen.findByText("真實訊息")).toBeInTheDocument();
    expect(screen.getByText(/同步 1 個 RoomEvent/)).toBeInTheDocument();
  });

  it("does not let a disposed socket navigate after unmount", async () => {
    let closeListener: ((event: { code?: number }) => void) | undefined;
    class TestWebSocket {
      readonly readyState = 0;
      send() {}
      close() {}
      addEventListener(type: string, listener: (event: { code?: number }) => void) {
        if (type === "close") closeListener = listener;
      }
    }
    vi.stubGlobal("WebSocket", TestWebSocket);
    const { unmount } = render(<RoomAccessClient gateway={gateway()} mode="student" roomId={roomId} />);
    await screen.findByRole("heading", { name: "生態系統探究" });
    unmount();
    closeListener?.({ code: 4401 });
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows a checking boundary instead of reading disposed state while changing rooms", async () => {
    const secondRoom = { ...room, roomId: otherRoomId, topic: "第二個課堂" };
    const api = gateway(teacher, {
      getRoom: vi.fn(async (requestedRoomId: string) => requestedRoomId === roomId ? room : secondRoom),
    });
    const { rerender } = render(<RoomAccessClient gateway={api} mode="teacher" roomId={roomId} />);
    await screen.findByRole("heading", { name: "生態系統探究" });
    rerender(<RoomAccessClient gateway={api} mode="teacher" roomId={otherRoomId} />);
    expect(screen.getByText("正在驗證 Session 與房間權限…")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "第二個課堂" })).toBeInTheDocument();
  });

  it("hides a same-room ready tree immediately while role authority is revalidated", async () => {
    const never = new Promise<AuthSession>(() => undefined);
    const getSession = vi.fn()
      .mockResolvedValueOnce(teacher)
      .mockImplementationOnce(async () => await never);
    const api = gateway(teacher, { getSession });
    const { rerender } = render(<RoomAccessClient gateway={api} mode="teacher" roomId={roomId} />);
    expect(await screen.findByRole("heading", { name: "生態系統探究" })).toBeInTheDocument();
    rerender(<RoomAccessClient gateway={api} mode="student" roomId={roomId} />);
    expect(screen.getByText("正在驗證 Session 與房間權限…")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "生態系統探究" })).not.toBeInTheDocument();
    expect(screen.queryByText("返回教師工作台")).not.toBeInTheDocument();
  });

  it("fails closed for a student URL naming another room without requesting its details", async () => {
    const api = gateway();
    render(<RoomAccessClient gateway={api} mode="student" roomId={otherRoomId} />);
    expect(await screen.findByRole("heading", { name: "無法開啟這個課堂" })).toBeInTheDocument();
    expect(api.getRoom).not.toHaveBeenCalled();
  });

  it("rejects a malformed route id before session or room data access", async () => {
    const api = gateway();
    render(<RoomAccessClient gateway={api} mode="student" roomId="demo-room" />);
    expect(await screen.findByRole("heading", { name: "無法開啟這個課堂" })).toBeInTheDocument();
    expect(api.getSession).not.toHaveBeenCalled();
    expect(api.getRoom).not.toHaveBeenCalled();
  });

  it("canonicalizes an owning teacher from the student route after server confirmation", async () => {
    const api = gateway(teacher);
    render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} />);
    await waitFor(() => expect(api.getRoom).toHaveBeenCalledWith(roomId));
    expect(replace).toHaveBeenCalledWith(`/session/${roomId}/teacher`);
  });

  it("never constructs teacher room state from a student session", async () => {
    const api = gateway(student);
    render(<RoomAccessClient gateway={api} mode="teacher" roomId={roomId} />);
    expect(await screen.findByRole("heading", { name: "無法開啟這個課堂" })).toBeInTheDocument();
    expect(api.getRoom).not.toHaveBeenCalled();
  });

  it("loads a teacher-owned room but hides a missing or foreign room", async () => {
    const ownerApi = gateway(teacher);
    const { unmount } = render(<RoomAccessClient gateway={ownerApi} mode="teacher" roomId={roomId} />);
    expect(await screen.findByText("教師房間控制台")).toBeInTheDocument();
    unmount();

    const foreignApi = gateway(teacher, {
      getRoom: vi.fn(async () => { throw new SessionGatewayError("ROOM_NOT_FOUND"); }),
    });
    render(<RoomAccessClient gateway={foreignApi} mode="teacher" roomId={otherRoomId} />);
    expect(await screen.findByRole("heading", { name: "目前的 Session 無法再開啟這個課堂" })).toBeInTheDocument();
  });

  it("redirects an expired session to the correct login entry", async () => {
    const api = gateway(student, {
      getSession: vi.fn(async () => { throw new SessionGatewayError("AUTH_REQUIRED"); }),
    });
    render(<RoomAccessClient gateway={api} mode="teacher" roomId={roomId} />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?role=teacher"));
    expect(api.getRoom).not.toHaveBeenCalled();
  });

  it("revokes a hydrated student session before returning to login", async () => {
    const api = gateway();
    render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} />);
    await screen.findByRole("heading", { name: "生態系統探究" });
    await userEvent.click(screen.getByRole("button", { name: "登出" }));
    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("offers logout recovery instead of a login loop when room hydration is unavailable", async () => {
    const api = gateway(student, {
      getRoomEvents: vi.fn(async () => { throw new SessionGatewayError("ROOM_SERVICE_UNAVAILABLE"); }),
    });
    render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} />);
    expect(await screen.findByRole("heading", { name: "課堂服務暫時不可用" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "清除 Session 並返回登入" }));
    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("clears the ready room before navigating after an expired socket session", async () => {
    let closeListener: ((event: { code?: number }) => void) | undefined;
    class TestWebSocket {
      readonly readyState = 0;
      constructor(readonly url: string) {}
      send() {}
      close() {}
      addEventListener(type: string, listener: (event: { code?: number }) => void) {
        if (type === "close") closeListener = listener;
      }
    }
    vi.stubGlobal("WebSocket", TestWebSocket);
    render(<RoomAccessClient gateway={gateway()} mode="student" roomId={roomId} />);
    await screen.findByRole("heading", { name: "生態系統探究" });
    closeListener?.({ code: 4401 });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
    expect(screen.queryByRole("heading", { name: "生態系統探究" })).not.toBeInTheDocument();
    expect(screen.getByText("正在驗證 Session 與房間權限…")).toBeInTheDocument();
  });

  it.each([4403, 4410] as const)("clears room authority without creating a login loop after close %s", async (code) => {
    let closeListener: ((event: { code?: number }) => void) | undefined;
    class TestWebSocket {
      readonly readyState = 0;
      send() {}
      close() {}
      addEventListener(type: string, listener: (event: { code?: number }) => void) {
        if (type === "close") closeListener = listener;
      }
    }
    vi.stubGlobal("WebSocket", TestWebSocket);
    const api = gateway();
    render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} />);
    await screen.findByRole("heading", { name: "生態系統探究" });
    closeListener?.({ code });
    expect(await screen.findByRole("heading", { name: "目前的 Session 無法再開啟這個課堂" })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "清除 Session 並返回登入" }));
    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith("/login");
  });

  it("hides all room data and offers real logout after an invalid native server frame", async () => {
    let messageListener: ((event: { data?: unknown }) => void) | undefined;
    const urls: string[] = [];
    class TestWebSocket {
      readonly readyState = 0;
      constructor(url: string) { urls.push(url); }
      send() {}
      close() {}
      addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
        if (type === "message") messageListener = listener;
      }
    }
    vi.stubGlobal("WebSocket", TestWebSocket);
    render(<RoomAccessClient gateway={gateway()} mode="student" roomId={roomId} />);
    await screen.findByRole("heading", { name: "生態系統探究" });
    messageListener?.({ data: "{not-json" });
    expect(await screen.findByRole("heading", { name: "即時同步已停止" })).toBeInTheDocument();
    expect(screen.queryByText("生態系統探究")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清除 Session 並返回登入" })).toBeInTheDocument();
    expect(urls).toHaveLength(1);
  });

  it("stops an open socket and hides last-good room data when live gap recovery fails", async () => {
    let messageListener: ((event: { data?: unknown }) => void) | undefined;
    const close = vi.fn();
    class TestWebSocket {
      readonly readyState = 0;
      send() {}
      close = close;
      addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
        if (type === "message") messageListener = listener;
      }
    }
    vi.stubGlobal("WebSocket", TestWebSocket);
    let initial = true;
    const api = gateway(student, {
      getRoomEvents: vi.fn(async () => {
        if (initial) {
          initial = false;
          return { events: [], throughRoomSeq: 0 };
        }
        throw new SessionGatewayError("ROOM_SERVICE_UNAVAILABLE");
      }),
    });
    render(<RoomAccessClient gateway={api} mode="student" roomId={roomId} />);
    await screen.findByRole("heading", { name: "生態系統探究" });
    messageListener?.({ data: JSON.stringify(messageEventFrame(2)) });
    expect(await screen.findByRole("heading", { name: "即時同步已停止" })).toBeInTheDocument();
    expect(screen.queryByText("生態系統探究")).not.toBeInTheDocument();
    expect(close).toHaveBeenCalledWith(1000, "client closed");
    messageListener?.({ data: JSON.stringify(messageEventFrame(1)) });
    expect(screen.queryByText("生態系統探究")).not.toBeInTheDocument();
  });
});
