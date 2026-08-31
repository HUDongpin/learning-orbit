import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";
import { CodeHasher } from "../../src/modules/rooms/seat-codes.js";
import { createCoreEventPayloadRegistry } from "@learning-orbit/contracts";
import { RoomEventRepository } from "../../src/modules/rooms/room-event-repository.js";

const ORIGIN = "https://app.learning-orbit.test";
const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const TEACHER_ID = "22222222-2222-4222-8222-222222222222";
const teacher = { role: "teacher", teacherId: TEACHER_ID, actorId: TEACHER_ID } as const;

describe("room read deletion boundary", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  async function appWith(query: ReturnType<typeof vi.fn>) {
    const client = { query, release: vi.fn() };
    const pool = { query, connect: vi.fn(async () => client) } as any;
    const sessions = {
      get: vi.fn(async () => teacher),
      getSessionId: vi.fn(async () => "33333333-3333-4333-8333-333333333333"),
      revoke: vi.fn(async () => undefined),
    };
    const app = await buildApp({
      pool,
      sessions: sessions as never,
      lifecycle: {
        closeIfDue: vi.fn(async () => null),
        events: {},
      } as never,
      codeHasher: new CodeHasher(1, new Map([[1, Buffer.alloc(32, 0x61)]])),
      config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN },
    });
    apps.push(app);
    return app;
  }

  it("returns 410 without loading room details after an owner starts deletion", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT 1 FROM classroom_room")) return { rows: [{ exists: 1 }], rowCount: 1 };
      if (sql.includes("SELECT 1 FROM deletion_job")) return { rows: [{ exists: 1 }], rowCount: 1 };
      if (sql.includes("JOIN room_member")) throw new Error("ROOM_DETAILS_MUST_NOT_LOAD_DURING_DELETION");
      return { rows: [], rowCount: 0 };
    });
    const app = await appWith(query);

    const response = await app.inject({
      method: "GET",
      url: `/v1/rooms/${ROOM_ID}`,
      headers: { origin: ORIGIN },
      cookies: { lo_session: "opaque" },
    });

    expect([response.statusCode, response.json()]).toEqual([410, { code: "DELETION_IN_PROGRESS" }]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("JOIN room_member"))).toBe(false);
  });

  it("keeps a cross-room teacher hidden before probing deletion state", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT 1 FROM classroom_room")) return { rows: [], rowCount: 0 };
      throw new Error("CROSS_ROOM_REQUEST_MUST_STOP_AT_OWNERSHIP");
    });
    const app = await appWith(query);

    const response = await app.inject({
      method: "GET",
      url: `/v1/rooms/${ROOM_ID}`,
      headers: { origin: ORIGIN },
      cookies: { lo_session: "opaque" },
    });

    expect([response.statusCode, response.json()]).toEqual([404, { code: "ROOM_NOT_FOUND" }]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects every room transaction before replaying an old successful command after deletion starts", async () => {
    const work = vi.fn(async () => "must-not-run");
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM classroom_room")) return { rows: [{
          room_id: ROOM_ID,
          nova_actor_id: "44444444-4444-4444-8444-444444444444",
          teacher_id: TEACHER_ID,
          topic: "生態系統探究",
          status: "closed",
          duration_seconds: 2700,
          starts_at: null,
          closes_at: null,
          closed_at: new Date("2026-08-31T01:00:00.000Z"),
          next_room_seq: "2",
          created_at: new Date("2026-08-31T00:00:00.000Z"),
        }] };
        if (sql.includes("FROM deletion_job")) return { rows: [{ deletion_active: true }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = new RoomEventRepository(
      { connect: vi.fn(async () => client) } as never,
      createCoreEventPayloadRegistry(),
    );

    await expect(repository.transact(ROOM_ID, work)).rejects.toMatchObject({
      code: "ROOM_DELETION_IN_PROGRESS",
    });
    expect(work).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("FROM deletion_job"))).toBe(true);
  });

  it("applies the deletion tombstone before Fastify parses a stale command body", async () => {
    const authenticateToken = vi.fn(async () => ({ ok: false as const, closeCode: 4410 as const }));
    const app = await buildApp({
      pool: { query: vi.fn(), connect: vi.fn() } as never,
      sessions: {
        get: vi.fn(async () => teacher),
        getSessionId: vi.fn(async () => "33333333-3333-4333-8333-333333333333"),
        revoke: vi.fn(async () => undefined),
      } as never,
      lifecycle: { events: {} } as never,
      realtime: {
        authorizer: { authenticateToken } as never,
        hub: {} as never,
        publisher: { tick: vi.fn(async () => undefined) } as never,
      },
      config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM_ID}/commands`,
      headers: { origin: ORIGIN, "content-type": "application/json" },
      cookies: { lo_session: "opaque" },
      payload: "{not-json",
    });

    expect([response.statusCode, response.json()]).toEqual([
      409,
      { code: "ROOM_DELETION_IN_PROGRESS" },
    ]);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(authenticateToken).toHaveBeenCalledWith("opaque", ROOM_ID);
  });
});
