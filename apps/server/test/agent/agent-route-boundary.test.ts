import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentCurrentState, AuthSession } from "@learning-orbit/contracts";
import { buildApp } from "../../src/app.js";

const ORIGIN = "https://app.learning-orbit.test";
const ROOM_ID = "a0000000-0000-4000-8000-000000000010";
const RUN_ID = "00000000-0000-4000-8000-000000000020";
const EVENT_ID = "00000000-0000-4000-8000-000000000030";
const SESSION_ID = "00000000-0000-4000-8000-000000000040";
const AT = "2026-08-31T01:00:00.000Z";
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
const teacher: Extract<AuthSession, { role: "teacher" }> = {
  role: "teacher",
  teacherId: "00000000-0000-4000-8000-000000000014",
  actorId: "00000000-0000-4000-8000-000000000014",
};
const teacherSessions = {
  get: async () => teacher,
  getSessionId: async () => SESSION_ID,
  revoke: async () => undefined,
};
const current: AgentCurrentState = {
  roomId: ROOM_ID,
  run: null,
  serviceHealth: "unavailable",
  agentEnabled: false,
  updatedAt: AT,
};

describe("public Agent route boundary", () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  async function appFor(agent: unknown, sessions: unknown = {
    get: async () => student,
    getSessionId: async () => SESSION_ID,
    revoke: async () => undefined,
  }) {
    const guardedAgent = agent && typeof agent === "object"
      ? { authorize: vi.fn(async () => undefined), ...(agent as Record<string, unknown>) }
      : agent;
    const app = await buildApp({
      config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN },
      agent: guardedAgent as never,
      sessions: sessions as never,
    });
    apps.push(app);
    return app;
  }

  it("returns generated unavailable state without exposing a run or provider detail", async () => {
    const agent = { current: vi.fn(async () => current) };
    const app = await appFor(agent);
    const response = await app.inject({
      method: "GET", url: `/v1/rooms/${ROOM_ID}/agent/current`,
      headers: { origin: ORIGIN }, cookies: { lo_session: "opaque" },
    });
    expect([response.statusCode, response.json()]).toEqual([200, current]);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(agent.current).toHaveBeenCalledWith(student, SESSION_ID, ROOM_ID);
  });

  it("keeps the route present and content-free when the Agent service is absent", async () => {
    const app = await appFor(undefined);
    const response = await app.inject({
      method: "GET", url: `/v1/rooms/${ROOM_ID}/agent/current`,
      headers: { origin: ORIGIN }, cookies: { lo_session: "opaque" },
    });
    expect([response.statusCode, response.json()]).toEqual([503, { code: "AGENT_SERVICE_UNAVAILABLE" }]);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("keeps the public route present without SessionService and authenticates before disclosing service state", async () => {
    const app = await buildApp({ config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN } });
    apps.push(app);
    const response = await app.inject({
      method: "GET", url: `/v1/rooms/${ROOM_ID}/agent/current`, headers: { origin: ORIGIN },
    });
    expect([response.statusCode, response.json()]).toEqual([401, { code: "AUTH_REQUIRED" }]);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("maps only the closed generated command parse failure and does not call Agent methods", async () => {
    const agent = {
      request: vi.fn(), cancel: vi.fn(), current: vi.fn(), settings: vi.fn(),
    };
    const app = await appFor(agent, teacherSessions);
    for (const request of [
      { method: "POST" as const, url: `/v1/rooms/${ROOM_ID}/agent/runs`, payload: { triggerEventId: EVENT_ID, candidateText: "leak" } },
      { method: "POST" as const, url: `/v1/rooms/${ROOM_ID}/agent/runs/${RUN_ID}/cancel`, payload: { extra: true } },
      { method: "PUT" as const, url: `/v1/rooms/${ROOM_ID}/agent/settings`, payload: { enabled: true, extra: true } },
    ]) {
      const response = await app.inject({ ...request, headers: { origin: ORIGIN }, cookies: { lo_session: "opaque" } });
      expect([response.statusCode, response.json()]).toEqual([422, { code: "INVALID_AGENT_COMMAND" }]);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(agent.request).not.toHaveBeenCalled();
    expect(agent.cancel).not.toHaveBeenCalled();
    expect(agent.settings).not.toHaveBeenCalled();
  });

  it("closes malformed JSON without exposing Fastify parser details", async () => {
    const agent = { request: vi.fn(), cancel: vi.fn(), current: vi.fn(), settings: vi.fn() };
    const app = await appFor(agent, teacherSessions);
    for (const request of [
      { method: "POST" as const, url: `/v1/rooms/${ROOM_ID}/agent/runs` },
      { method: "POST" as const, url: `/v1/rooms/${ROOM_ID}/agent/runs/${RUN_ID}/cancel` },
      { method: "PUT" as const, url: `/v1/rooms/${ROOM_ID}/agent/settings` },
    ]) {
      const response = await app.inject({
        ...request,
        payload: '{"broken":',
        headers: { origin: ORIGIN, "content-type": "application/json" },
        cookies: { lo_session: "opaque" },
      });
      expect([response.statusCode, response.json()]).toEqual([422, { code: "INVALID_AGENT_COMMAND" }]);
      expect(Object.keys(response.json())).toEqual(["code"]);
      expect(response.body).not.toMatch(/FST_ERR|Fastify|Unexpected|position/iu);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(agent.request).not.toHaveBeenCalled();
    expect(agent.cancel).not.toHaveBeenCalled();
    expect(agent.settings).not.toHaveBeenCalled();
  });

  it("authenticates before parsing an anonymous malformed Agent command", async () => {
    const agent = { request: vi.fn(), cancel: vi.fn(), current: vi.fn(), settings: vi.fn() };
    const sessions = {
      get: vi.fn(async () => null),
      getSessionId: vi.fn(async () => null),
      revoke: vi.fn(async () => undefined),
    };
    const app = await appFor(agent, sessions);
    const response = await app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM_ID}/agent/runs`,
      payload: '{"broken":',
      headers: { origin: ORIGIN, "content-type": "application/json" },
    });

    expect([response.statusCode, response.json()]).toEqual([401, { code: "AUTH_REQUIRED" }]);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(agent.request).not.toHaveBeenCalled();
  });

  it("closes an empty application/json body with the same generated command error", async () => {
    const agent = { request: vi.fn(), cancel: vi.fn(), settings: vi.fn() };
    const app = await appFor(agent, teacherSessions);
    for (const request of [
      { method: "POST" as const, url: `/v1/rooms/${ROOM_ID}/agent/runs` },
      { method: "POST" as const, url: `/v1/rooms/${ROOM_ID}/agent/runs/${RUN_ID}/cancel` },
      { method: "PUT" as const, url: `/v1/rooms/${ROOM_ID}/agent/settings` },
    ]) {
      const response = await app.inject({
        ...request,
        payload: "",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        cookies: { lo_session: "opaque" },
      });
      expect([response.statusCode, response.json()]).toEqual([422, { code: "INVALID_AGENT_COMMAND" }]);
      expect(Object.keys(response.json())).toEqual(["code"]);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(agent.request).not.toHaveBeenCalled();
    expect(agent.cancel).not.toHaveBeenCalled();
    expect(agent.settings).not.toHaveBeenCalled();
  });

  it("applies the frozen per-room actor trigger limit before a fourth creation", async () => {
    let admittedCreations = 0;
    const agent = {
      request: vi.fn(async (_session, _sessionId, _roomId, _eventId, options) => {
        await options.admitCreate();
        admittedCreations += 1;
        return {
        run: { agentRunId: RUN_ID, state: "queued" as const },
        created: true,
        };
      }),
    };
    const app = await appFor(agent);
    const responses = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      responses.push(await app.inject({
        method: "POST", url: `/v1/rooms/${attempt === 3 ? ROOM_ID.toUpperCase() : ROOM_ID}/agent/runs`, payload: { triggerEventId: EVENT_ID },
        headers: { origin: ORIGIN }, cookies: { lo_session: "opaque" },
      }));
    }
    expect(responses.slice(0, 3).map(({ statusCode }) => statusCode)).toEqual([202, 202, 202]);
    expect([responses[3]?.statusCode, responses[3]?.json()]).toEqual([429, { code: "RATE_LIMITED" }]);
    expect(agent.request).toHaveBeenCalledTimes(4);
    expect(admittedCreations).toBe(3);
  });

  it("rejects unexpected Agent query fields instead of trusting spoofed rate identities", async () => {
    const agent = { current: vi.fn(async () => current) };
    const app = await appFor(agent);
    const response = await app.inject({
      method: "GET",
      url: `/v1/rooms/${ROOM_ID}/agent/current?roomId=other&actorId=other&token=secret`,
      headers: { origin: ORIGIN },
      cookies: { lo_session: "opaque" },
    });
    expect([response.statusCode, response.json()]).toEqual([400, { code: "INVALID_QUERY" }]);
    expect(agent.current).not.toHaveBeenCalled();
    expect(response.body).not.toContain("secret");
  });

  it("returns 202 only for a newly inserted run and 200 for an idempotent retry", async () => {
    const agent = {
      request: vi.fn()
        .mockResolvedValueOnce({ run: { agentRunId: RUN_ID, state: "queued" }, created: true })
        .mockResolvedValueOnce({ run: { agentRunId: RUN_ID, state: "completed" }, created: false }),
    };
    const app = await appFor(agent);
    const request = {
      method: "POST" as const, url: `/v1/rooms/${ROOM_ID}/agent/runs`, payload: { triggerEventId: EVENT_ID },
      headers: { origin: ORIGIN }, cookies: { lo_session: "opaque" },
    };
    const first = await app.inject(request);
    const retry = await app.inject(request);
    expect([first.statusCode, first.json()]).toEqual([202, { agentRunId: RUN_ID, state: "queued" }]);
    expect([retry.statusCode, retry.json()]).toEqual([200, { agentRunId: RUN_ID, state: "completed" }]);
  });

  it("preserves the explicit-trigger policy as a forbidden same-room action", async () => {
    const app = await appFor({ request: vi.fn(async () => {
      const { AgentError } = await import("../../src/modules/agent/agent-service.js");
      throw new AgentError("EXPLICIT_TRIGGER_REQUIRED");
    }) });
    const response = await app.inject({
      method: "POST", url: `/v1/rooms/${ROOM_ID}/agent/runs`, payload: { triggerEventId: EVENT_ID },
      headers: { origin: ORIGIN }, cookies: { lo_session: "opaque" },
    });
    expect([response.statusCode, response.json()]).toEqual([403, { code: "EXPLICIT_TRIGGER_REQUIRED" }]);
  });

  it("returns the generated deletion tombstone code for stale Agent settings", async () => {
    const app = await appFor({ settings: vi.fn(async () => {
      const { AgentError } = await import("../../src/modules/agent/agent-service.js");
      throw new AgentError("ROOM_DELETION_IN_PROGRESS");
    }) }, teacherSessions);
    const response = await app.inject({
      method: "PUT",
      url: `/v1/rooms/${ROOM_ID}/agent/settings`,
      payload: { enabled: false },
      headers: { origin: ORIGIN },
      cookies: { lo_session: "opaque" },
    });
    expect([response.statusCode, response.json()]).toEqual([409, { code: "ROOM_DELETION_IN_PROGRESS" }]);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("returns a closed 503 when the admitted Agent service reports no usable Executor", async () => {
    const app = await appFor({ request: vi.fn(async () => {
      const { AgentError } = await import("../../src/modules/agent/agent-service.js");
      throw new AgentError("AGENT_SERVICE_UNAVAILABLE");
    }) });
    const response = await app.inject({
      method: "POST", url: `/v1/rooms/${ROOM_ID}/agent/runs`, payload: { triggerEventId: EVENT_ID },
      headers: { origin: ORIGIN }, cookies: { lo_session: "opaque" },
    });
    expect([response.statusCode, response.json()]).toEqual([503, { code: "AGENT_SERVICE_UNAVAILABLE" }]);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("maps unexpected Agent and session failures to INTERNAL without leaking details", async () => {
    const failedAgent = await appFor({ current: vi.fn(async () => { throw new Error("provider endpoint secret"); }) });
    const failed = await failedAgent.inject({
      method: "GET", url: `/v1/rooms/${ROOM_ID}/agent/current`,
      headers: { origin: ORIGIN }, cookies: { lo_session: "opaque" },
    });
    expect([failed.statusCode, failed.json()]).toEqual([500, { code: "INTERNAL" }]);
    expect(failed.body).not.toContain("provider endpoint secret");

    const preflight = await appFor({
      request: vi.fn(), cancel: vi.fn(), current: vi.fn(), settings: vi.fn(),
    }, {
      get: async () => { throw new Error("database host secret"); },
      getSessionId: async () => SESSION_ID,
      revoke: async () => undefined,
    });
    for (const request of [
      { method: "POST" as const, url: `/v1/rooms/${ROOM_ID}/agent/runs`, payload: { triggerEventId: EVENT_ID } },
      { method: "POST" as const, url: `/v1/rooms/${ROOM_ID}/agent/runs/${RUN_ID}/cancel`, payload: {} },
      { method: "GET" as const, url: `/v1/rooms/${ROOM_ID}/agent/current` },
      { method: "PUT" as const, url: `/v1/rooms/${ROOM_ID}/agent/settings`, payload: { enabled: false } },
    ]) {
      const response = await preflight.inject({ ...request, headers: { origin: ORIGIN }, cookies: { lo_session: "opaque" } });
      expect([response.statusCode, response.json()]).toEqual([500, { code: "INTERNAL" }]);
      expect(response.body).not.toMatch(/database host secret|stack/iu);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });
});
