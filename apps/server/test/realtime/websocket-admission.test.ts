import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../../src/app.js";

const ORIGIN = "https://app.learning-orbit.test";
const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const SESSION_ID = "00000000-0000-4000-8000-000000000011";
const ACTOR_ID = "00000000-0000-4000-8000-000000000012";
const principal = {
  role: "teacher" as const,
  teacherId: ACTOR_ID,
  actorId: ACTOR_ID,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function withTimeout<T>(promise: Promise<T>, code: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), 1_000);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

describe("WebSocket admission", () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it.each(["realtime", "ws"] as const)(
    "does not drop an immediate hello on /%s while database authorization is pending",
    async (routeSuffix) => {
      const admission = deferred<{
        ok: true;
        sessionId: string;
        principal: typeof principal;
        actorId: string;
      }>();
      const authorization = {
        ok: true as const,
        sessionId: SESSION_ID,
        principal,
        actorId: ACTOR_ID,
      };
      const authStarted = deferred<void>();
      const authenticateToken = vi.fn(() => {
        authStarted.resolve(undefined);
        return admission.promise;
      });
      const firstMessage = deferred<string>();
      const connect = vi.fn((socket: { on(event: string, listener: (raw: unknown) => void): void }) => {
        socket.on("message", (raw) => {
          if (typeof raw === "string") firstMessage.resolve(raw);
          else if (raw instanceof Uint8Array) firstMessage.resolve(Buffer.from(raw).toString("utf8"));
        });
      });
      const app = await buildApp({
        config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN },
        pool: { query: vi.fn() } as never,
        sessions: {
          get: vi.fn(async () => null),
          getSessionId: vi.fn(async () => null),
          revoke: vi.fn(async () => undefined),
        } as never,
        lifecycle: { events: {} } as never,
        realtime: {
          authorizer: {
            authenticateToken,
            reauthorize: vi.fn(async () => ({ ok: true, principal, actorId: ACTOR_ID })),
          } as never,
          hub: { connect } as never,
          publisher: { tick: vi.fn(async () => 0) } as never,
        },
      });
      apps.push(app);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("TEST_LISTENER_UNAVAILABLE");

      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/rooms/${ROOM_ID}/${routeSuffix}`, {
        headers: { cookie: "lo_session=opaque-session", origin: ORIGIN },
      });
      sockets.push(socket);
      let opened = false;
      socket.on("open", () => {
        opened = true;
        socket.send(JSON.stringify({
          type: "hello",
          clientId: "00000000-0000-4000-8000-000000000013",
          resumeFrom: 0,
        }));
      });

      const started = await withTimeout(authStarted.promise, "AUTHORIZATION_NOT_STARTED")
        .then(() => true, () => false);
      if (!started) {
        admission.resolve(authorization);
        throw new Error("AUTHORIZATION_NOT_STARTED");
      }
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      const openedBeforeAdmission = opened;
      admission.resolve(authorization);

      const payload = await withTimeout(firstMessage.promise, "EARLY_HELLO_DROPPED");
      expect(JSON.parse(payload)).toEqual({
        type: "hello",
        clientId: "00000000-0000-4000-8000-000000000013",
        resumeFrom: 0,
      });
      expect(openedBeforeAdmission).toBe(false);
      expect(authenticateToken).toHaveBeenCalledWith("opaque-session", ROOM_ID);
      expect(connect).toHaveBeenCalledOnce();
    },
  );

  it("preserves authorization close codes and hides admission failures", async () => {
    const cases: Array<{
      expectedCode: 4401 | 4403 | 4410 | 1011;
      authenticate(): Promise<{ ok: false; closeCode: 4401 | 4403 | 4410 }>;
    }> = [
      { expectedCode: 4401, authenticate: async () => ({ ok: false, closeCode: 4401 }) },
      { expectedCode: 4403, authenticate: async () => ({ ok: false, closeCode: 4403 }) },
      { expectedCode: 4410, authenticate: async () => ({ ok: false, closeCode: 4410 }) },
      {
        expectedCode: 1011,
        authenticate: async () => { throw new Error("private database failure detail"); },
      },
    ];

    for (const testCase of cases) {
      const connect = vi.fn();
      const authenticateToken = vi.fn(testCase.authenticate);
      const app = await buildApp({
        config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN },
        pool: { query: vi.fn() } as never,
        sessions: {
          get: vi.fn(async () => null),
          getSessionId: vi.fn(async () => null),
          revoke: vi.fn(async () => undefined),
        } as never,
        lifecycle: { events: {} } as never,
        realtime: {
          authorizer: {
            authenticateToken,
            reauthorize: vi.fn(async () => ({ ok: false, closeCode: 4401 })),
          } as never,
          hub: { connect } as never,
          publisher: { tick: vi.fn(async () => 0) } as never,
        },
      });
      apps.push(app);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("TEST_LISTENER_UNAVAILABLE");

      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/rooms/${ROOM_ID}/realtime`, {
        headers: { cookie: "lo_session=opaque-session", origin: ORIGIN },
      });
      sockets.push(socket);
      const close = await withTimeout(new Promise<{ code: number; reason: string }>((resolve) => {
        socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
      }), "AUTHORIZATION_CLOSE_TIMEOUT");

      expect(close).toEqual({ code: testCase.expectedCode, reason: "authorization required" });
      expect(close.reason).not.toContain("database");
      expect(authenticateToken).toHaveBeenCalledWith("opaque-session", ROOM_ID);
      expect(connect).not.toHaveBeenCalled();
    }
  });
});
