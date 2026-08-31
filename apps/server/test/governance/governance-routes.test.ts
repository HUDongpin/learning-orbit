import cookie from "@fastify/cookie";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deletionLifecycleContract } from "@learning-orbit/contracts";
import { registerGovernanceRoutes } from "../../src/modules/governance/governance-routes.js";
import { GovernanceError } from "../../src/modules/governance/governance-service.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const JOB_ID = "00000000-0000-4000-8000-000000000011";
const teacher = {
  role: "teacher" as const,
  teacherId: "00000000-0000-4000-8000-000000000012",
  actorId: "00000000-0000-4000-8000-000000000012",
};
const queued = deletionLifecycleContract.parseStatus({
  deletionJobId: JOB_ID,
  status: "queued",
  nextPollAfterMs: 1000,
  failureCode: null,
});

describe("governance HTTP no-store boundary", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  async function appFor(fail = false) {
    const app = fastify();
    await app.register(cookie);
    const failure = async () => { throw new GovernanceError("ROOM_NOT_FOUND", 404); };
    const service = fail ? {
      authorizeRoom: failure,
      requestDeletion: failure,
      deletionStatus: failure,
      deletionStatusForRoom: failure,
      exportRoom: failure,
    } : {
      authorizeRoom: vi.fn(async () => teacher),
      requestDeletion: vi.fn(async () => ({ deletionJobId: JOB_ID, status: "queued" as const })),
      deletionStatus: vi.fn(async () => queued),
      deletionStatusForRoom: vi.fn(async () => queued),
      exportRoom: vi.fn(async () => ({ fileName: "learning-orbit-room-export.json", filename: "learning-orbit-room-export.json", contentType: "application/json; charset=utf-8", body: "[]" })),
    };
    const sessions = { get: vi.fn(async () => teacher) };
    await registerGovernanceRoutes(app, service as never, sessions as never);
    apps.push(app);
    return app;
  }

  it("marks every success response no-store", async () => {
    const app = await appFor();
    const responses = [
      await app.inject({ method: "DELETE", url: `/v1/rooms/${ROOM_ID}`, cookies: { lo_session: "opaque" }, payload: { confirmation: `DELETE ${ROOM_ID}` } }),
      await app.inject({ method: "GET", url: `/v1/deletions/${JOB_ID}`, cookies: { lo_session: "opaque" } }),
      await app.inject({ method: "GET", url: `/v1/rooms/${ROOM_ID}/deletion`, cookies: { lo_session: "opaque" } }),
      await app.inject({ method: "GET", url: `/v1/rooms/${ROOM_ID}/export?format=json`, cookies: { lo_session: "opaque" } }),
    ];
    expect(responses.map(({ statusCode }) => statusCode)).toEqual([202, 200, 200, 200]);
    for (const response of responses) expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("marks hidden failures no-store and returns only the stable code", async () => {
    const app = await appFor(true);
    const responses = [
      await app.inject({ method: "DELETE", url: `/v1/rooms/${ROOM_ID}`, cookies: { lo_session: "opaque" }, payload: { secret: "must-not-return" } }),
      await app.inject({ method: "GET", url: `/v1/deletions/${JOB_ID}`, cookies: { lo_session: "opaque" } }),
      await app.inject({ method: "GET", url: `/v1/rooms/${ROOM_ID}/deletion`, cookies: { lo_session: "opaque" } }),
      await app.inject({ method: "GET", url: `/v1/rooms/${ROOM_ID}/export?format=invalid`, cookies: { lo_session: "opaque" } }),
    ];
    for (const response of responses) {
      expect([response.statusCode, response.json()]).toEqual([404, { code: "ROOM_NOT_FOUND" }]);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("must-not-return");
    }
  });

  it("authenticates before Fastify parses an anonymous malformed deletion body", async () => {
    const app = fastify();
    await app.register(cookie);
    const requestDeletion = vi.fn();
    const service = {
      authorizeRoom: vi.fn(),
      requestDeletion,
      deletionStatus: vi.fn(),
      deletionStatusForRoom: vi.fn(),
      exportRoom: vi.fn(),
    };
    const sessions = { get: vi.fn(async () => null) };
    await registerGovernanceRoutes(app, service as never, sessions as never);
    apps.push(app);

    const response = await app.inject({
      method: "DELETE",
      url: `/v1/rooms/${ROOM_ID}`,
      headers: { "content-type": "application/json" },
      payload: '{"broken":',
    });

    expect([response.statusCode, response.json()]).toEqual([401, { code: "AUTH_REQUIRED" }]);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(requestDeletion).not.toHaveBeenCalled();
  });

  it("returns a stable delete parser code only after hidden ownership authorization", async () => {
    const request = {
      method: "DELETE" as const,
      url: `/v1/rooms/${ROOM_ID}`,
      headers: { "content-type": "application/json" },
      cookies: { lo_session: "opaque" },
      payload: '{"broken":',
    };
    const authorized = await appFor();
    const parsed = await authorized.inject(request);
    expect([parsed.statusCode, parsed.json()]).toEqual([400, { code: "INVALID_DELETE_REQUEST" }]);

    const hidden = await appFor(true);
    const denied = await hidden.inject(request);
    expect([denied.statusCode, denied.json()]).toEqual([404, { code: "ROOM_NOT_FOUND" }]);
  });
});
