import { describe, expect, it, vi } from "vitest";

import { realtimeContract } from "@learning-orbit/contracts";

import { RealtimeConnection } from "../../src/modules/realtime/connection.js";
import { RoomHub } from "../../src/modules/realtime/room-hub.js";

const ROOM = "00000000-0000-4000-8000-000000000010";
const OTHER_ROOM = "00000000-0000-4000-8000-000000000020";
const ACTOR_A = "00000000-0000-4000-8000-000000000012";
const ACTOR_B = "00000000-0000-4000-8000-000000000022";

const principal = {
  role: "student",
  roomId: ROOM,
  roomMemberId: "00000000-0000-4000-8000-000000000013",
  actorId: ACTOR_A,
  pseudonym: "A",
  nova: {
    actorId: "00000000-0000-4000-8000-000000000014",
    actorKind: "agent",
    actorRole: "socratic_facilitator",
    displayName: "Nova Agent",
  },
} as never;

class Socket {
  sent: string[] = [];
  closed?: number;
  handlers = new Map<string, (...args: never[]) => void>();
  send(value: string) { this.sent.push(value); }
  close(code?: number) { this.closed = code; }
  on(event: string, cb: (...args: never[]) => void) { this.handlers.set(event, cb); }
  frames() { return this.sent.map((raw) => JSON.parse(raw)); }
}

function hubHarness(now = () => new Date(0)) {
  const authorizer = {
    reauthorize: vi.fn(async () => ({ ok: true, principal, actorId: ACTOR_A })),
  } as never as ConstructorParameters<typeof RoomHub>[1];
  const pool = {
    query: vi.fn(async (sql: string) => (sql.includes("outbox_event")
      ? { rows: [] }
      : { rows: [{ next_room_seq: "1", status: "open" }] })),
  } as never;
  const hub = new RoomHub(pool, authorizer, now);
  const commands = { dispatch: vi.fn() } as never;
  return { hub, commands };
}

async function connected(hub: RoomHub, commands: never, actorId: string, roomId = ROOM) {
  const socket = new Socket();
  const connection = hub.connect(
    socket as never,
    { sessionId: `session-${actorId}`, roomId, principal, actorId },
    commands,
  );
  await connection.receive({
    type: "hello",
    clientId: "00000000-0000-4000-8000-000000000015",
    resumeFrom: 0,
  });
  socket.sent.length = 0;
  return { socket, connection };
}

describe("realtime signal contract", () => {
  it("refuses a server-shaped frame arriving from a client", async () => {
    const { hub, commands } = hubHarness();
    const { socket, connection } = await connected(hub, commands, ACTOR_A);

    // Every one of these validates against the two-way RealtimeFrame union,
    // so a socket parsing with that union admits them from a client.
    for (const frame of [
      { type: "welcome", serverTime: new Date(0).toISOString(), roomId: ROOM, cursor: 0, status: "open" },
      { type: "ack", commandId: "00000000-0000-4000-8000-000000000016", roomSeq: 1, revision: 1 },
      { type: "presence", actorId: ACTOR_B, state: "active", expiresAt: new Date(0).toISOString() },
      { type: "degraded", scope: "realtime", code: "ANYTHING", updatedAt: new Date(0).toISOString() },
    ]) {
      expect(() => realtimeContract.parseRealtimeFrame(frame)).not.toThrow();
      expect(() => realtimeContract.parseClientFrame(frame)).toThrow("INVALID_CLIENT_FRAME");
    }

    await connection.receive({
      type: "presence",
      actorId: ACTOR_B,
      state: "active",
      expiresAt: new Date(0).toISOString(),
    });

    expect(socket.closed).toBe(4400);
    expect(socket.frames()).toEqual([]);
  });

  it("announces a departure instead of leaving a closed tab looking present", async () => {
    const { hub, commands } = hubHarness();
    const leaving = await connected(hub, commands, ACTOR_A);
    const watching = await connected(hub, commands, ACTOR_B);

    leaving.connection.close(1000, "closed");
    await new Promise((resolve) => { setImmediate(resolve); });

    expect(watching.socket.frames()).toEqual([
      { type: "presence", actorId: ACTOR_A, state: "away", expiresAt: expect.any(String) },
      { type: "typing", actorId: ACTOR_A, active: false, expiresAt: expect.any(String) },
    ]);
    // The departing socket never receives its own tombstone.
    expect(leaving.socket.frames()).toEqual([]);
  });

  it("stays silent while another socket for the same actor is still open", async () => {
    const { hub, commands } = hubHarness();
    const firstTab = await connected(hub, commands, ACTOR_A);
    await connected(hub, commands, ACTOR_A);
    const watching = await connected(hub, commands, ACTOR_B);

    firstTab.connection.close(1000, "closed");
    await new Promise((resolve) => { setImmediate(resolve); });

    expect(watching.socket.frames()).toEqual([]);
  });

  it("tells a student their analytics are withheld rather than leaving them waiting", async () => {
    const { hub, commands } = hubHarness();
    const { socket } = await connected(hub, commands, ACTOR_A);
    const frame = {
      type: "projection" as const,
      roomId: ROOM,
      projectionKey: "echo.student_approved" as const,
      analysisEpoch: "00000000-0000-4000-8000-000000000031",
      projectionVersion: 3,
      snapshotUrl: `/v1/rooms/${ROOM}/analytics/echo.student_approved/latest`,
    };

    const sent = await hub.broadcastProjectionAuthorized(ROOM, frame, async () => ({ allow: false }));

    expect(sent).toBe(0);
    expect(socket.frames()).toEqual([{
      type: "degraded",
      scope: "analytics",
      code: "STUDENT_ANALYTICS_NOT_PROMOTED",
      projectionKey: "echo.student_approved",
      updatedAt: new Date(0).toISOString(),
    }]);
    for (const emitted of socket.frames()) {
      expect(() => realtimeContract.parseServerFrame(emitted)).not.toThrow();
    }
  });

  it("reports a failed promotion read as retryable, not as an empty result", async () => {
    const { hub, commands } = hubHarness();
    const { socket } = await connected(hub, commands, ACTOR_A);

    const sent = await hub.broadcastProjectionAuthorized(ROOM, {
      type: "projection",
      roomId: ROOM,
      projectionKey: "trace.student_bundle",
      analysisEpoch: "00000000-0000-4000-8000-000000000031",
      projectionVersion: 1,
      snapshotUrl: `/v1/rooms/${ROOM}/analytics/trace.student_bundle/latest`,
    }, async () => { throw new Error("PROMOTION_READ_FAILED"); });

    expect(sent).toBe(0);
    expect(socket.frames()).toEqual([{
      type: "degraded",
      scope: "analytics",
      code: "ANALYTICS_UNAVAILABLE",
      updatedAt: new Date(0).toISOString(),
      retryAfterMs: 5_000,
    }]);
  });

  it("says nothing about promotion when a teacher projection is withheld", async () => {
    const { hub, commands } = hubHarness();
    const { socket } = await connected(hub, commands, ACTOR_A);

    await hub.broadcastProjectionAuthorized(ROOM, {
      type: "projection",
      roomId: ROOM,
      projectionKey: "echo.teacher_shadow",
      analysisEpoch: "00000000-0000-4000-8000-000000000031",
      projectionVersion: 1,
      snapshotUrl: `/v1/rooms/${ROOM}/analytics/echo.teacher_shadow/latest`,
    }, async () => ({ allow: false }));

    expect(socket.frames()).toEqual([]);
  });

  it("keeps a departure inside its own room", async () => {
    const { hub, commands } = hubHarness();
    const leaving = await connected(hub, commands, ACTOR_A);
    const elsewhere = await connected(hub, commands, ACTOR_B, OTHER_ROOM);

    leaving.connection.close(1000, "closed");
    await new Promise((resolve) => { setImmediate(resolve); });

    expect(elsewhere.socket.frames()).toEqual([]);
  });
});
