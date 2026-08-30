import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@learning-orbit/contracts";
import { buildApp } from "../../src/app.js";
import { MemoryMediaStore } from "../../src/modules/media/s3-media-store.js";

const ORIGIN = "https://app.learning-orbit.test";
const student: Extract<AuthSession, { role: "student" }> = {
  role: "student",
  roomId: "00000000-0000-4000-8000-000000000010",
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

describe("media provider construction boundary", () => {
  const pools: Pool[] = [];
  afterEach(async () => Promise.all(pools.splice(0).map((pool) => pool.end())));

  function pool(): Pool {
    const value = new Pool({ connectionString: "postgres://unused.invalid/media-boundary" });
    pools.push(value);
    return value;
  }

  it("returns content-free 503 with zero database writes when no reviewed store is injected", async () => {
    const database = pool();
    const app = await buildApp({
      pool: database,
      config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN, storageBrowserOrigins: [] },
      sessions: {
        get: async () => student,
        getSessionId: async () => "00000000-0000-4000-8000-000000000020",
        revoke: async () => undefined,
      } as never,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/rooms/${student.roomId}/media/uploads`,
        headers: { origin: ORIGIN },
        cookies: { lo_session: "opaque" },
        payload: {},
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ code: "MEDIA_SERVICE_UNAVAILABLE" });
      expect(database.totalCount).toBe(0);
    } finally { await app.close(); }
  });

  it("refuses an injected store unless exact browser origins are configured", async () => {
    const database = pool();
    await expect(buildApp({
      pool: database,
      mediaStore: new MemoryMediaStore("https://storage.learning-orbit.test"),
      config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN, storageBrowserOrigins: [] },
    })).rejects.toThrow("LO_STORAGE_BROWSER_ORIGINS_REQUIRED");
  });

  it("cannot bypass an empty server allowlist by injecting complete media dependencies", async () => {
    const mediaPoolQuery = vi.fn();
    const storeCall = vi.fn();
    const app = await buildApp({
      config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN, storageBrowserOrigins: [] },
      sessions: {
        get: async () => student,
        getSessionId: async () => "00000000-0000-4000-8000-000000000020",
        revoke: async () => undefined,
      } as never,
      media: {
        pool: { query: mediaPoolQuery },
        store: { createUploadUrl: storeCall },
        config: { storageBrowserOrigins: ["http://127.0.0.1:59000"] },
      } as never,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/rooms/${student.roomId}/media/uploads`,
        headers: { origin: ORIGIN },
        cookies: { lo_session: "opaque" },
        payload: {},
      });
      expect([response.statusCode, response.json()]).toEqual([503, { code: "MEDIA_SERVICE_UNAVAILABLE" }]);
      expect(mediaPoolQuery).not.toHaveBeenCalled();
      expect(storeCall).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("closes session-preflight failures on every public media route without leaking details", async () => {
    const app = await buildApp({
      config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN, storageBrowserOrigins: [] },
      sessions: {
        get: async () => { throw new Error("database host secret"); },
        getSessionId: async () => { throw new Error("session table secret"); },
        revoke: async () => undefined,
      } as never,
    });
    try {
      for (const request of [
        { method: "POST" as const, url: `/v1/rooms/${student.roomId}/media/uploads`, payload: {} },
        { method: "POST" as const, url: `/v1/rooms/${student.roomId}/media/${student.actorId}/complete`, payload: {} },
        { method: "GET" as const, url: `/v1/rooms/${student.roomId}/media/${student.actorId}` },
        { method: "GET" as const, url: `/v1/rooms/${student.roomId}/media/${student.actorId}/download` },
      ]) {
        const response = await app.inject({ ...request, headers: { origin: ORIGIN }, cookies: { lo_session: "opaque" } });
        expect([response.statusCode, response.json()]).toEqual([500, { code: "INTERNAL" }]);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).not.toMatch(/database host secret|session table secret|stack/iu);
      }
    } finally { await app.close(); }
  });
});
