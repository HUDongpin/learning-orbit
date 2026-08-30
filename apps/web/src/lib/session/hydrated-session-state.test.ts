import { describe, expect, it, vi } from "vitest";

import type { AuthSession, RoomDetails, RoomEventEnvelope } from "@learning-orbit/contracts";
import { HydratedSessionState } from "./hydrated-session-state.js";
import { SessionGatewayError } from "./session-gateway.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const AT = "2026-08-30T09:00:00.000Z";
const CLOSES = "2026-08-30T09:45:00.000Z";
const student: Extract<AuthSession, { role: "student" }> = {
  role: "student",
  roomId: ROOM_ID,
  roomMemberId: "00000000-0000-4000-8000-000000000011",
  actorId: "00000000-0000-4000-8000-000000000012",
  pseudonym: "探索者 A",
  nova: { actorId: "00000000-0000-4000-8000-000000000013", actorKind: "agent", actorRole: "socratic_facilitator", displayName: "Nova Agent" },
};
const room: RoomDetails = {
  roomId: ROOM_ID,
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

function event(seq: number, kind: "open" | "message" = "message"): RoomEventEnvelope {
  const common = {
    eventId: `00000000-0000-4000-8001-${String(seq).padStart(12, "0")}`,
    schemaVersion: 1 as const,
    roomId: ROOM_ID,
    roomSeq: seq,
    revision: 1,
    operation: "add" as const,
    eventTime: `2026-08-30T09:0${seq}:00.000Z`,
    ingestTime: `2026-08-30T09:0${seq}:01.000Z`,
    causationId: `00000000-0000-4000-8002-${String(seq).padStart(12, "0")}`,
    correlationId: "00000000-0000-4000-8000-000000000401",
  };
  if (kind === "open") {
    return {
      ...common,
      type: "room.opened",
      actorId: "00000000-0000-4000-8000-000000000099",
      actorKind: "system",
      actorRole: "room_clock",
      payload: { startsAt: AT, closesAt: CLOSES },
    };
  }
  return {
    ...common,
    type: "message.added",
    actorId: student.actorId,
    actorKind: "human",
    actorRole: "student",
    payload: {
      messageId: `00000000-0000-4000-8003-${String(seq).padStart(12, "0")}`,
      text: `訊息 ${seq}`,
      replyTo: null,
      mentions: [],
      mediaIds: [],
    },
  };
}

describe("HydratedSessionState", () => {
  it("hydrates generated Agent current state and keeps endpoint unavailability explicit", async () => {
    const gateway = { getRoomEvents: vi.fn(async () => ({ events: [], throughRoomSeq: 0 })) };
    const hydrated = await HydratedSessionState.create({
      session: student,
      room,
      gateway,
      agentCurrent: {
        roomId: ROOM_ID,
        run: null,
        serviceHealth: "unavailable",
        agentEnabled: false,
        updatedAt: AT,
      },
    });
    expect(hydrated.agentStatus).toMatchObject({
      type: "agent_status", roomId: ROOM_ID, agentRunId: null, state: "idle",
      serviceHealth: "unavailable", agentEnabled: false,
    });
    expect(hydrated.agentServiceUnavailable).toBe(false);

    const unavailable = await HydratedSessionState.create({
      session: student, room, gateway, agentServiceUnavailable: true,
    });
    expect(unavailable.agentStatus).toBeUndefined();
    expect(unavailable.agentServiceUnavailable).toBe(true);
    unavailable.clearForSessionExpiry();
    expect(unavailable.agentServiceUnavailable).toBe(false);
  });

  it("orders Agent run transitions by persisted run time instead of REST assembly time", async () => {
    const runId = "00000000-0000-4000-8000-000000000801";
    const hydrated = await HydratedSessionState.create({
      session: student,
      room,
      gateway: { getRoomEvents: vi.fn(async () => ({ events: [], throughRoomSeq: 0 })) },
      agentCurrent: {
        roomId: ROOM_ID,
        run: {
          agentRunId: runId,
          state: "queued",
          failureCode: null,
          createdAt: "2026-08-30T09:00:00.000Z",
          updatedAt: "2026-08-30T09:00:01.000Z",
        },
        serviceHealth: "healthy",
        agentEnabled: true,
        updatedAt: "2026-08-30T09:00:03.000Z",
      },
    });
    hydrated.receiveFrame({
      type: "agent_status", roomId: ROOM_ID, agentRunId: runId, state: "running",
      serviceHealth: "healthy", agentEnabled: true, updatedAt: "2026-08-30T09:00:02.000Z", failureCode: null,
    });
    expect(hydrated.agentStatus?.state).toBe("running");
  });

  it("rejects same-time regressions, conflicting terminal upgrades, and unproven run replacement", async () => {
    const runA = "00000000-0000-4000-8000-000000000801";
    const runB = "00000000-0000-4000-8000-000000000802";
    const hydrated = await HydratedSessionState.create({
      session: student,
      room,
      gateway: { getRoomEvents: vi.fn(async () => ({ events: [], throughRoomSeq: 0 })) },
    });
    const frame = (overrides: Record<string, unknown>) => ({
      type: "agent_status" as const, roomId: ROOM_ID, agentRunId: runA, state: "streaming" as const,
      serviceHealth: "healthy" as const, agentEnabled: true,
      updatedAt: "2026-08-30T09:00:01.000Z", failureCode: null, ...overrides,
    });
    hydrated.receiveFrame(frame({}));
    hydrated.receiveFrame(frame({ state: "queued" }));
    expect(hydrated.agentStatus).toMatchObject({ agentRunId: runA, state: "streaming" });

    hydrated.receiveFrame(frame({ state: "failed", failureCode: "PROVIDER_UNAVAILABLE", updatedAt: "2026-08-30T09:00:02.000Z" }));
    hydrated.receiveFrame(frame({ state: "completed", failureCode: null, updatedAt: "2026-08-30T09:00:02.000Z" }));
    expect(hydrated.agentStatus).toMatchObject({ agentRunId: runA, state: "failed" });

    hydrated.receiveFrame(frame({ agentRunId: runB, state: "queued", failureCode: null, updatedAt: "2026-08-30T09:00:02.000Z" }));
    expect(hydrated.agentStatus).toMatchObject({ agentRunId: runA, state: "failed" });
    hydrated.receiveFrame(frame({ agentRunId: runB, state: "queued", failureCode: null, updatedAt: "2026-08-30T09:00:03.000Z" }));
    expect(hydrated.agentStatus).toMatchObject({ agentRunId: runB, state: "queued" });
    hydrated.receiveFrame(frame({ agentRunId: runA, state: "completed", failureCode: null, updatedAt: "2026-08-30T09:00:04.000Z" }));
    expect(hydrated.agentStatus).toMatchObject({ agentRunId: runB, state: "queued" });
  });

  it("does not let a delayed pre-idle run overwrite an authoritative idle watermark", async () => {
    const hydrated = await HydratedSessionState.create({
      session: student,
      room,
      gateway: { getRoomEvents: vi.fn(async () => ({ events: [], throughRoomSeq: 0 })) },
      agentCurrent: {
        roomId: ROOM_ID, run: null, serviceHealth: "healthy", agentEnabled: true,
        updatedAt: "2026-08-30T09:00:10.000Z",
      },
    });
    hydrated.receiveFrame({
      type: "agent_status", roomId: ROOM_ID,
      agentRunId: "00000000-0000-4000-8000-000000000801", state: "queued",
      serviceHealth: "healthy", agentEnabled: true, updatedAt: "2026-08-30T09:00:09.000Z", failureCode: null,
    });
    expect(hydrated.agentStatus).toMatchObject({ agentRunId: null, state: "idle" });
  });

  it("reconciles Agent current after every resume and lets a live frame supersede a pending refresh", async () => {
    const runId = "00000000-0000-4000-8000-000000000801";
    const getAgentCurrent = vi.fn()
      .mockResolvedValueOnce({
        roomId: ROOM_ID,
        run: { agentRunId: runId, state: "running", failureCode: null, createdAt: AT, updatedAt: "2026-08-30T09:00:02.000Z" },
        serviceHealth: "healthy", agentEnabled: true, updatedAt: "2026-08-30T09:00:02.500Z",
      })
      .mockResolvedValueOnce({
        roomId: ROOM_ID,
        run: { agentRunId: runId, state: "streaming", failureCode: null, createdAt: AT, updatedAt: "2026-08-30T09:00:03.000Z" },
        serviceHealth: "healthy", agentEnabled: true, updatedAt: "2026-08-30T09:00:03.500Z",
      })
      .mockImplementationOnce(async (_roomId: string, options?: { signal?: AbortSignal }) => await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }));
    const hydrated = await HydratedSessionState.create({
      session: student,
      room,
      gateway: { getRoomEvents: vi.fn(async () => ({ events: [], throughRoomSeq: 0 })), getAgentCurrent },
      agentCurrent: {
        roomId: ROOM_ID,
        run: { agentRunId: runId, state: "queued", failureCode: null, createdAt: AT, updatedAt: "2026-08-30T09:00:01.000Z" },
        serviceHealth: "healthy", agentEnabled: true, updatedAt: "2026-08-30T09:00:01.500Z",
      },
      agentStatusTimeoutMs: 10,
    });
    hydrated.receiveFrame({ type: "resume_complete", throughRoomSeq: 0 });
    expect(hydrated.agentStatusPending).toBe(true);
    await hydrated.whenIdle();
    expect(hydrated.agentStatus?.state).toBe("running");
    hydrated.receiveFrame({ type: "resume_complete", throughRoomSeq: 0 });
    await hydrated.whenIdle();
    expect(hydrated.agentStatus?.state).toBe("streaming");

    hydrated.receiveFrame({ type: "resume_complete", throughRoomSeq: 0 });
    hydrated.receiveFrame({
      type: "agent_status", roomId: ROOM_ID, agentRunId: runId, state: "completed",
      serviceHealth: "healthy", agentEnabled: true, updatedAt: "2026-08-30T09:00:04.000Z", failureCode: null,
    });
    await hydrated.whenIdle();
    expect(hydrated.agentStatus?.state).toBe("completed");
    expect(hydrated.agentServiceUnavailable).toBe(false);
    expect(getAgentCurrent).toHaveBeenCalledTimes(3);
  });

  it("marks only the Agent slot unavailable when a resume reconciliation fails", async () => {
    const runId = "00000000-0000-4000-8000-000000000801";
    const hydrated = await HydratedSessionState.create({
      session: student,
      room,
      gateway: {
        getRoomEvents: vi.fn(async () => ({ events: [], throughRoomSeq: 0 })),
        getAgentCurrent: vi.fn(async () => { throw new SessionGatewayError("AGENT_SERVICE_UNAVAILABLE"); }),
      },
      agentCurrent: {
        roomId: ROOM_ID,
        run: { agentRunId: runId, state: "running", failureCode: null, createdAt: AT, updatedAt: AT },
        serviceHealth: "healthy", agentEnabled: true, updatedAt: AT,
      },
    });
    hydrated.receiveFrame({ type: "resume_complete", throughRoomSeq: 0 });
    await hydrated.whenIdle();
    expect(hydrated.agentStatus?.state).toBe("running");
    expect(hydrated.agentServiceUnavailable).toBe(true);
    expect(hydrated.sessionState.roomId).toBe(ROOM_ID);
  });

  it("does not let a stale live Agent frame cancel the post-resume authoritative refresh", async () => {
    const runId = "00000000-0000-4000-8000-000000000801";
    let resolveCurrent!: (value: {
      roomId: string;
      run: { agentRunId: string; state: "streaming"; failureCode: null; createdAt: string; updatedAt: string };
      serviceHealth: "healthy";
      agentEnabled: true;
      updatedAt: string;
    }) => void;
    const current = new Promise<Parameters<typeof resolveCurrent>[0]>((resolve) => { resolveCurrent = resolve; });
    const hydrated = await HydratedSessionState.create({
      session: student,
      room,
      gateway: {
        getRoomEvents: vi.fn(async () => ({ events: [], throughRoomSeq: 0 })),
        getAgentCurrent: vi.fn(async () => await current),
      },
      agentCurrent: {
        roomId: ROOM_ID,
        run: { agentRunId: runId, state: "running", failureCode: null, createdAt: AT, updatedAt: "2026-08-30T09:00:10.000Z" },
        serviceHealth: "healthy", agentEnabled: true, updatedAt: "2026-08-30T09:00:10.500Z",
      },
    });
    hydrated.receiveFrame({ type: "resume_complete", throughRoomSeq: 0 });
    hydrated.receiveFrame({
      type: "agent_status", roomId: ROOM_ID, agentRunId: runId, state: "running",
      serviceHealth: "healthy", agentEnabled: true, updatedAt: "2026-08-30T09:00:10.000Z", failureCode: null,
    });
    hydrated.receiveFrame({
      type: "agent_status", roomId: ROOM_ID, agentRunId: runId, state: "queued",
      serviceHealth: "healthy", agentEnabled: true, updatedAt: "2026-08-30T09:00:09.000Z", failureCode: null,
    });
    resolveCurrent({
      roomId: ROOM_ID,
      run: { agentRunId: runId, state: "streaming", failureCode: null, createdAt: AT, updatedAt: "2026-08-30T09:00:11.000Z" },
      serviceHealth: "healthy", agentEnabled: true, updatedAt: "2026-08-30T09:00:11.500Z",
    });
    await hydrated.whenIdle();
    expect(hydrated.agentStatus?.state).toBe("streaming");
    expect(hydrated.agentServiceUnavailable).toBe(false);
    expect(hydrated.agentStatusPending).toBe(false);
  });

  it("lets authoritative REST current replace an old active run after missed terminal frames", async () => {
    const runA = "00000000-0000-4000-8000-000000000801";
    const runB = "00000000-0000-4000-8000-000000000802";
    const hydrated = await HydratedSessionState.create({
      session: student,
      room,
      gateway: {
        getRoomEvents: vi.fn(async () => ({ events: [], throughRoomSeq: 0 })),
        getAgentCurrent: vi.fn(async () => ({
          roomId: ROOM_ID,
          run: {
            agentRunId: runB,
            state: "queued" as const,
            failureCode: null,
            createdAt: "2026-08-30T09:00:03.000Z",
            updatedAt: "2026-08-30T09:00:03.000Z",
          },
          serviceHealth: "healthy" as const,
          agentEnabled: true,
          updatedAt: "2026-08-30T09:00:03.500Z",
        })),
      },
      agentCurrent: {
        roomId: ROOM_ID,
        run: {
          agentRunId: runA,
          state: "running",
          failureCode: null,
          createdAt: "2026-08-30T09:00:01.000Z",
          updatedAt: "2026-08-30T09:00:01.000Z",
        },
        serviceHealth: "healthy",
        agentEnabled: true,
        updatedAt: "2026-08-30T09:00:01.500Z",
      },
    });
    hydrated.receiveFrame({ type: "resume_complete", throughRoomSeq: 0 });
    await hydrated.whenIdle();
    expect(hydrated.agentStatus).toMatchObject({ agentRunId: runB, state: "queued" });
  });

  it("settles and clears the local Agent timeout on dispose even when a Gateway ignores AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      const hydrated = await HydratedSessionState.create({
        session: student,
        room,
        gateway: {
          getRoomEvents: vi.fn(async () => ({ events: [], throughRoomSeq: 0 })),
          getAgentCurrent: vi.fn(async () => await new Promise<never>(() => undefined)),
        },
        agentStatusTimeoutMs: 1_000,
      });
      const refresh = hydrated.refreshAgentCurrent();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      hydrated.dispose();
      await refresh;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hydrates paginated REST events contiguously and derives server room timing", async () => {
    const getRoomEvents = vi.fn(async (_roomId: string, afterSeq: number) => afterSeq === 0
      ? { events: [event(1, "open"), event(2)], throughRoomSeq: 2, nextAfterSeq: 2 }
      : { events: [event(3)], throughRoomSeq: 3 });
    const hydrated = await HydratedSessionState.create({
      session: student,
      room,
      gateway: { getRoomEvents },
      pageLimit: 2,
      commandClock: () => new Date(AT),
      commandUuid: () => "00000000-0000-4000-8000-000000000201",
    });
    expect(getRoomEvents.mock.calls.map(([, after]) => after)).toEqual([0, 2]);
    expect(hydrated.ledger.lastRoomSeq).toBe(3);
    expect(hydrated.ledger.messages()).toHaveLength(2);
    expect(hydrated.sessionState).toMatchObject({ status: "open", startsAt: AT, closesAt: CLOSES, lastRoomSeq: 3 });
    expect(hydrated.progress(new Date("2026-08-30T09:22:30.000Z").getTime())).toEqual({ elapsedSeconds: 1350, ratio: 0.5 });
    const commandId = hydrated.sendIntent({ type: "message.add", text: "只在伺服器確認後顯示", replyTo: null, mentions: [], mediaIds: [] });
    expect(commandId).toBe("00000000-0000-4000-8000-000000000201");
    expect(hydrated.pendingCommandIds()).toEqual([commandId]);
    expect(hydrated.messages()).toHaveLength(2);
    hydrated.receiveFrame({ type: "ack", commandId, roomSeq: 4, revision: 1 });
    expect(hydrated.pendingCommandIds()).toEqual([]);
    expect(hydrated.sessionState.lastRoomSeq).toBe(3);
    hydrated.receiveFrame({
      type: "event",
      event: {
        ...event(4),
        type: "room.paused",
        actorId: "00000000-0000-4000-8000-000000000099",
        actorKind: "system",
        actorRole: "room_clock",
        payload: { pausedAt: "2026-08-30T09:23:00.000Z" },
      },
    });
    expect(hydrated.sessionState).toMatchObject({ status: "paused", closesAt: CLOSES, lastRoomSeq: 4 });
    expect(hydrated.progress(new Date("2026-08-30T09:30:00.000Z").getTime()).elapsedSeconds).toBe(1800);
    expect(() => hydrated.sendIntent({ type: "message.add", text: "暫停時不可送出", replyTo: null, mentions: [], mediaIds: [] }))
      .toThrow("ROOM_NOT_OPEN");
  });

  it("recovers a live gap through authenticated event pages without skipping the missing event", async () => {
    let bootstrap = true;
    const getRoomEvents = vi.fn(async (_roomId: string, afterSeq: number) => {
      if (bootstrap) {
        bootstrap = false;
        return { events: [event(1)], throughRoomSeq: 1 };
      }
      expect(afterSeq).toBe(1);
      return { events: [event(2), event(3)], throughRoomSeq: 3 };
    });
    const hydrated = await HydratedSessionState.create({ session: student, room, gateway: { getRoomEvents } });
    hydrated.receiveFrame({ type: "event", event: event(3) });
    await hydrated.whenIdle();
    expect(hydrated.ledger.events().map(({ roomSeq }) => roomSeq)).toEqual([1, 2, 3]);
    expect(hydrated.sessionState.lastRoomSeq).toBe(3);
  });

  it("holds a 4409 reconnect until delayed pages reach the required cursor", async () => {
    vi.useFakeTimers();
    let hydrated: HydratedSessionState | undefined;
    try {
      let finishPage!: (page: { events: RoomEventEnvelope[]; throughRoomSeq: number }) => void;
      const delayedPage = new Promise<{ events: RoomEventEnvelope[]; throughRoomSeq: number }>((resolve) => {
        finishPage = resolve;
      });
      let bootstrapped = false;
      const gateway = {
        getRoomEvents: vi.fn(async () => {
          if (!bootstrapped) {
            bootstrapped = true;
            return { events: [], throughRoomSeq: 0 };
          }
          return delayedPage;
        }),
      };
      hydrated = await HydratedSessionState.create({
        session: student,
        room,
        gateway,
        retryDelaysMs: [10],
      });
      const sockets: Array<{ readyState: number; sent: string[]; send(value: string): void }> = [];
      const connect = vi.fn(() => {
        const sent: string[] = [];
        const socket = { readyState: 1, sent, send: (value: string) => sent.push(value) };
        sockets.push(socket);
        return socket;
      });
      hydrated.connect(connect);
      hydrated.receiveFrame({ type: "snapshot_required", afterSeq: 0, throughRoomSeq: 2 });
      hydrated.socket.onClose(4409);
      vi.advanceTimersByTime(100);
      expect(connect).toHaveBeenCalledOnce();

      finishPage({ events: [event(1), event(2)], throughRoomSeq: 2 });
      await hydrated.whenIdle();
      await Promise.resolve();
      vi.advanceTimersByTime(10);

      expect(hydrated.ledger.lastRoomSeq).toBe(2);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(JSON.parse(sockets[1]!.sent[0]!)).toMatchObject({ type: "hello", resumeFrom: 2 });
    } finally {
      hydrated?.dispose();
      vi.useRealTimers();
    }
  });

  it("partitions control, media, agent, projection, presence, typing, and degraded frames", async () => {
    const hydrated = await HydratedSessionState.create({
      session: student,
      room,
      gateway: { getRoomEvents: vi.fn(async () => ({ events: [], throughRoomSeq: 0 })) },
    });
    const commandId = "00000000-0000-4000-8000-000000000201";
    const actorId = "00000000-0000-4000-8000-000000000301";
    hydrated.receiveFrame({ type: "welcome", serverTime: AT, roomId: ROOM_ID, cursor: 0, status: "paused" });
    hydrated.receiveFrame({ type: "resume_complete", throughRoomSeq: 0 });
    hydrated.receiveFrame({ type: "ack", commandId, roomSeq: 1, revision: 1 });
    hydrated.receiveFrame({ type: "presence", actorId, state: "active", expiresAt: CLOSES });
    hydrated.receiveFrame({ type: "typing", actorId, active: true, expiresAt: CLOSES });
    hydrated.receiveFrame({ type: "media_status", mediaId: "00000000-0000-4000-8000-000000000701", state: "processing", failureCode: null, updatedAt: AT });
    hydrated.receiveFrame({ type: "agent_status", roomId: ROOM_ID, agentRunId: null, state: "idle", serviceHealth: "unavailable", agentEnabled: false, updatedAt: AT, failureCode: null });
    hydrated.receiveFrame({ type: "agent_status", roomId: ROOM_ID, agentRunId: "00000000-0000-4000-8000-000000000801", state: "running", serviceHealth: "healthy", agentEnabled: true, updatedAt: "2026-08-30T08:59:00.000Z", failureCode: null });
    hydrated.receiveFrame({ type: "projection", roomId: ROOM_ID, projectionKey: "echo.student_approved", analysisEpoch: "00000000-0000-4000-8000-000000000601", projectionVersion: 1, completeThroughRoomSeq: 0, snapshotUrl: `/v1/rooms/${ROOM_ID}/analytics/echo.student_approved/latest` });
    hydrated.receiveFrame({ type: "degraded", scope: "media", code: "PROVIDER_UNAVAILABLE", updatedAt: AT });
    expect(hydrated.sessionState).toMatchObject({ connected: true, status: "paused", lastRoomSeq: 0 });
    expect(hydrated.acks.get(commandId)?.revision).toBe(1);
    expect(hydrated.presence.get(actorId)?.state).toBe("active");
    expect(hydrated.typing.get(actorId)?.active).toBe(true);
    expect(hydrated.mediaStatuses.has("00000000-0000-4000-8000-000000000701")).toBe(false);
    expect(hydrated.agentStatus?.serviceHealth).toBe("unavailable");
    expect(hydrated.projections.current("echo.student_approved")?.projectionVersion).toBe(1);
    expect(hydrated.degraded.get("media")?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(hydrated.ledger.lastRoomSeq).toBe(0);
    hydrated.socket.onClose(4400);
    expect(hydrated.recoveryError).toBe("REALTIME_PROTOCOL_ERROR");
    expect(hydrated.ledger.lastRoomSeq).toBe(0);
  });

  it("bounds media status to server-confirmed active message attachments and prunes it on retract", async () => {
    const hydrated = await HydratedSessionState.create({
      session: student,
      room,
      gateway: { getRoomEvents: vi.fn(async () => ({ events: [], throughRoomSeq: 0 })) },
    });
    for (let index = 0; index < 1_000; index += 1) {
      hydrated.receiveFrame({
        type: "media_status",
        mediaId: `00000000-0000-4000-8007-${String(index).padStart(12, "0")}`,
        state: "processing",
        failureCode: null,
        updatedAt: AT,
      });
    }
    expect(hydrated.mediaStatuses.size).toBe(0);
    expect(hydrated.ledger.lastRoomSeq).toBe(0);

    const mediaId = "00000000-0000-4000-8000-000000000701";
    const equalTimestampMediaId = "00000000-0000-4000-8000-000000000702";
    const added = {
      ...event(1),
      payload: { ...(event(1).payload as Record<string, unknown>), mediaIds: [mediaId, equalTimestampMediaId] },
    } as RoomEventEnvelope;
    hydrated.receiveFrame({ type: "event", event: added });
    hydrated.receiveFrame({ type: "media_status", mediaId, state: "processing", failureCode: null, updatedAt: AT });
    hydrated.receiveFrame({
      type: "media_status",
      mediaId: "00000000-0000-4000-8000-000000000799",
      state: "ready",
      failureCode: null,
      updatedAt: AT,
    });
    expect([...hydrated.mediaStatuses.keys()]).toEqual([mediaId]);

    hydrated.receiveFrame({
      type: "media_status", mediaId, state: "quarantined", failureCode: "POLICY",
      updatedAt: "2026-08-30T09:02:00.000Z",
    });
    hydrated.receiveFrame({
      type: "media_status", mediaId, state: "ready", failureCode: null,
      updatedAt: "2026-08-30T09:01:00.000Z",
    });
    hydrated.receiveFrame({
      type: "media_status", mediaId, state: "processing", failureCode: null,
      updatedAt: "2026-08-30T09:02:00.000Z",
    });
    expect(hydrated.mediaStatuses.get(mediaId)).toMatchObject({ state: "quarantined", failureCode: "POLICY" });
    hydrated.receiveFrame({
      type: "media_status", mediaId: equalTimestampMediaId, state: "ready", failureCode: null,
      updatedAt: "2026-08-30T09:03:00.000Z",
    });
    hydrated.receiveFrame({
      type: "media_status", mediaId: equalTimestampMediaId, state: "quarantined", failureCode: "POLICY",
      updatedAt: "2026-08-30T09:03:00.000Z",
    });
    expect(hydrated.mediaStatuses.get(equalTimestampMediaId)).toMatchObject({ state: "quarantined", failureCode: "POLICY" });

    hydrated.receiveFrame({
      type: "event",
      event: {
        ...event(2),
        type: "message.retracted",
        revision: 2,
        operation: "retract",
        payload: { messageId: (added.payload as { messageId: string }).messageId },
      },
    });
    expect(hydrated.mediaStatuses.size).toBe(0);
    expect(hydrated.ledger.lastRoomSeq).toBe(2);
  });

  it("fails closed on a malformed page sequence and clears all state on session expiry", async () => {
    const identityGateway = { getRoomEvents: vi.fn(async () => ({ events: [], throughRoomSeq: 0 })) };
    await expect(HydratedSessionState.create({
      session: student,
      room: { ...room, nova: { ...room.nova, actorId: "00000000-0000-4000-8000-000000000099" } },
      gateway: identityGateway,
    })).rejects.toThrow("HYDRATED_SESSION_IDENTITY_MISMATCH");
    expect(identityGateway.getRoomEvents).not.toHaveBeenCalled();
    await expect(HydratedSessionState.create({
      session: student,
      room: { ...room, participants: [room.participants[0], room.participants[0], room.participants[2], room.participants[3]] },
      gateway: identityGateway,
    })).rejects.toThrow("HYDRATED_ROOM_ROSTER_INVALID");

    await expect(HydratedSessionState.create({
      session: student,
      room,
      gateway: { getRoomEvents: vi.fn(async () => ({ events: [event(2)], throughRoomSeq: 2 })) },
    })).rejects.toThrow("ROOM_EVENT_PAGE_GAP");

    const expired = vi.fn();
    const hydrated = await HydratedSessionState.create({
      session: student,
      room,
      gateway: { getRoomEvents: vi.fn(async () => ({ events: [event(1)], throughRoomSeq: 1 })) },
      onSessionExpired: expired,
    });
    hydrated.clearForSessionExpiry();
    expect(expired).toHaveBeenCalledTimes(1);
    expect(hydrated.expired).toBe(true);
    expect(hydrated.ledger.events()).toEqual([]);
    expect(hydrated.projections.references()).toEqual([]);
    expect(hydrated.sessionState).toMatchObject({ connected: false, lastRoomSeq: 0 });
    expect(hydrated.sessionState.roomId).toBe("");
    expect(() => hydrated.session).toThrow("SESSION_STATE_CLEARED");
    expect(() => hydrated.room).toThrow("SESSION_STATE_CLEARED");

    let firstPage = true;
    const authorityLost = vi.fn();
    const lost = await HydratedSessionState.create({
      session: student,
      room,
      gateway: {
        getRoomEvents: vi.fn(async () => {
          if (firstPage) { firstPage = false; return { events: [event(1)], throughRoomSeq: 1 }; }
          throw new SessionGatewayError("ROOM_NOT_FOUND");
        }),
      },
      onRoomUnavailable: authorityLost,
    });
    await expect(lost.recoverEvents()).rejects.toEqual(new SessionGatewayError("ROOM_NOT_FOUND"));
    expect(authorityLost).toHaveBeenCalledTimes(1);
    expect(lost.expired).toBe(false);
    expect(lost.roomUnavailable).toBe(true);
    expect(lost.ledger.events()).toEqual([]);
  });
});
