import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@learning-orbit/contracts";

import { buildApp } from "../../src/app.js";
import { roomEventHttpAccessFailure } from "../../src/modules/realtime/room-event-http-access.js";

const ORIGIN = "https://app.learning-orbit.test";
const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const teacher: Extract<AuthSession, { role: "teacher" }> = {
  role: "teacher",
  teacherId: "00000000-0000-4000-8000-000000000001",
  actorId: "00000000-0000-4000-8000-000000000001",
};
const student: Extract<AuthSession, { role: "student" }> = {
  role: "student",
  roomId: ROOM_ID,
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

describe("room event HTTP authorization mapping", () => {
  it("hides every room authorization miss after the route established a valid Session", () => {
    for (const closeCode of [4401, 4403, 4410] as const) {
      expect(roomEventHttpAccessFailure({ ok: false, closeCode })).toEqual({
        statusCode: 404,
        code: "ROOM_NOT_FOUND",
      });
    }
    expect(roomEventHttpAccessFailure({
      ok: true,
      sessionId: "00000000-0000-4000-8000-000000000001",
      actorId: "00000000-0000-4000-8000-000000000002",
      principal: {
        role: "teacher",
        teacherId: "00000000-0000-4000-8000-000000000002",
        actorId: "00000000-0000-4000-8000-000000000002",
      },
    })).toBeNull();
  });
});

describe("GET /v1/rooms/:roomId/events authority boundary", () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  async function appFor(identity: AuthSession | null, authorization: unknown, finalAuthorization: unknown = authorization) {
    const authenticateToken = vi.fn(async () => authorization);
    const reauthorize = vi.fn(async () => finalAuthorization);
    const eventsAfter = vi.fn(async () => []);
    const app = await buildApp({
      config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN },
      sessions: {
        get: vi.fn(async () => identity),
        getSessionId: vi.fn(async () => null),
        revoke: vi.fn(async () => undefined),
      } as never,
      lifecycle: { events: { eventsAfter } } as never,
      realtime: {
        authorizer: { authenticateToken, reauthorize } as never,
        hub: {} as never,
        publisher: { tick: vi.fn(async () => undefined) } as never,
      },
    });
    apps.push(app);
    return { app, authenticateToken, reauthorize, eventsAfter };
  }

  it("returns 401 only when the browser Session itself is absent", async () => {
    const anonymous = await appFor(null, { ok: false, closeCode: 4401 });
    const response = await anonymous.app.inject({
      method: "GET",
      url: `/v1/rooms/${ROOM_ID}/events?afterSeq=0&limit=500`,
      headers: { origin: ORIGIN },
    });
    expect([response.statusCode, response.json()]).toEqual([401, { code: "AUTH_REQUIRED" }]);
    expect(anonymous.authenticateToken).not.toHaveBeenCalled();
    expect(anonymous.eventsAfter).not.toHaveBeenCalled();
  });

  it("returns the same hidden 404 for valid student/teacher Sessions after any room-token denial", async () => {
    for (const identity of [student, teacher]) {
      for (const closeCode of [4401, 4403, 4410] as const) {
        const value = await appFor(identity, { ok: false, closeCode });
        const response = await value.app.inject({
          method: "GET",
          url: `/v1/rooms/${ROOM_ID}/events?afterSeq=0&limit=500`,
          cookies: { lo_session: "opaque-session" },
          headers: { origin: ORIGIN },
        });
        expect([response.statusCode, response.json()]).toEqual([404, { code: "ROOM_NOT_FOUND" }]);
        expect(value.eventsAfter).not.toHaveBeenCalled();
      }
    }
  });

  it("rechecks authority after the event read so deletion cannot race a page response", async () => {
    const sessionId = "00000000-0000-4000-8000-000000000099";
    const initial = { ok: true, sessionId, principal: teacher, actorId: teacher.actorId } as const;
    const value = await appFor(teacher, initial, { ok: false, closeCode: 4410 });
    const response = await value.app.inject({
      method: "GET",
      url: `/v1/rooms/${ROOM_ID}/events?afterSeq=0&limit=500`,
      cookies: { lo_session: "opaque-session" },
      headers: { origin: ORIGIN },
    });
    expect(value.eventsAfter).toHaveBeenCalledOnce();
    expect(value.reauthorize).toHaveBeenCalledWith(sessionId, ROOM_ID);
    expect([response.statusCode, response.json()]).toEqual([404, { code: "ROOM_NOT_FOUND" }]);
  });
});
