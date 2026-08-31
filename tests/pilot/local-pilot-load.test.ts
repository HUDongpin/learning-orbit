import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import {
  PILOT_FIXTURE,
  PILOT_TARGETS,
  buildLocalWebSocketUrl,
  buildPilotReport,
  deterministicJitterSeconds,
  deterministicUuid,
  summarizeMilliseconds,
  validatePilotReport,
} from "../load/pilot-load-contract.mjs";
import {
  assertProviderDisabled,
  derivePilotRunIdentity,
  extractOpaqueSessionCookie,
  loadPilotCaFile,
  LocalHttpsClient,
} from "../load/pilot-load-http.mjs";
import {
  LoadConnectionTracker,
  PilotWebSocketClient,
} from "../load/pilot-load-websocket.mjs";

const root = resolve(import.meta.dirname, "../..");

const metric = (p50: number, p95: number, p99: number, samples = 80) => ({
  samples, p50, p95, p99,
});

function passingInput() {
  return {
    sourceSha: "a".repeat(40),
    maxConcurrentClients: 50,
    reconnects: 50,
    commandsSent: 80,
    committedEvents: 90,
    committedEventLoss: 0,
    duplicateCommittedEvents: 0,
    roomSeqGaps: 0,
    providerChecks: {
      media: "MEDIA_SERVICE_UNAVAILABLE",
      agent: "AGENT_SERVICE_UNAVAILABLE",
    },
    textAckMs: metric(120, 700, 1_400),
    outboxLagMs: metric(90, 900, 980),
    deterministicProjectionLagMs: metric(450, 2_800, 2_950, 20),
    replayMs: metric(80, 600, 900, 50),
    projectionNodes: 60,
    projectionEdges: 40,
    errorRate: 0,
    backpressure: { snapshotRequired: 1, controlledCloses: 1 },
    environment: {
      node: "v24.19.0",
      platform: "darwin",
      arch: "arm64",
      cpuCount: 12,
      postgresImage: "postgres:18@sha256:" + "b".repeat(64),
      mailpitImage: "axllent/mailpit:v1.31.0@sha256:" + "c".repeat(64),
    },
  };
}

describe("controlled local-pilot load contract", () => {
  it("freezes exactly 10 rooms, 40 students, 10 teachers, and 50 concurrent clients", async () => {
    expect(PILOT_FIXTURE).toEqual({
      rooms: 10,
      studentsPerRoom: 4,
      teachersPerRoom: 1,
      studentClients: 40,
      teacherClients: 10,
      teacherSessions: 1,
      concurrentClients: 50,
      reconnects: 50,
      messageRounds: 2,
    });
    expect(PILOT_TARGETS).toEqual({
      textAckP95Ms: 750,
      textAckP99Ms: 1_500,
      outboxP95Ms: 1_000,
      deterministicProjectionP95Ms: 3_000,
    });
    const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
    expect(manifest.scripts["load:pilot"]).toBe("node tests/load/run-local-pilot.mjs");
    const loadRunner = await readFile(resolve(root, "tests/load/run-local-pilot.mjs"), "utf8");
    expect(loadRunner).toContain('createRequire(resolve(root, "apps/server/package.json"))');
    expect(loadRunner).toContain('serverRequire.resolve("@learning-orbit/contracts")');
    expect(loadRunner).not.toContain('packages/contracts/dist/index.js');
    expect(loadRunner).toContain("const BACKPRESSURE_COMMANDS = 640;");
    expect(loadRunner).toContain("const EVENT_PAGE_LIMIT = 64;");
    expect(loadRunner).toContain("const roomWork = classrooms.map((room) => {");
    expect(loadRunner).toContain("messagesComplete.then(() => {");
    expect(loadRunner).not.toContain("await Promise.all(students.map(async");
    const verifier = await readFile(resolve(root, "scripts/verify-local-pilot.mjs"), "utf8");
    expect(verifier).toContain("LO_PILOT_TLS_CA_FILE: state.tls.certificatePath");
  });

  it("uses deterministic 8-20 second message jitter and stable UUIDs", () => {
    const values = Array.from(
      { length: 80 },
      (_, index) => deterministicJitterSeconds(index % 40, Math.floor(index / 40)),
    );
    expect(Math.min(...values)).toBe(8);
    expect(Math.max(...values)).toBe(20);
    expect(values.every((value) => Number.isSafeInteger(value) && value >= 8 && value <= 20)).toBe(true);
    expect(deterministicUuid("pilot:room:0")).toBe(deterministicUuid("pilot:room:0"));
    expect(deterministicUuid("pilot:room:0")).not.toBe(deterministicUuid("pilot:room:1"));
    expect(deterministicUuid("pilot:room:0")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("builds only the exact local WSS route without a credential query", () => {
    const roomId = "00000000-0000-4000-8000-000000000001";
    expect(buildLocalWebSocketUrl("https://127.0.0.1:3000", `/v1/rooms/${roomId}/realtime`))
      .toBe(`wss://127.0.0.1:3000/v1/rooms/${roomId}/realtime`);
    expect(() => buildLocalWebSocketUrl("http://127.0.0.1:3000", `/v1/rooms/${roomId}/realtime`))
      .toThrow("PILOT_LOAD_ORIGIN_INVALID");
    expect(() => buildLocalWebSocketUrl("https://localhost:3000", `/v1/rooms/${roomId}/realtime`))
      .toThrow("PILOT_LOAD_ORIGIN_INVALID");
    expect(() => buildLocalWebSocketUrl("https://127.0.0.1:3000", `/v1/rooms/${roomId}/realtime?token=hidden`))
      .toThrow("PILOT_LOAD_WEBSOCKET_URL_INVALID");
  });

  it("computes bounded nearest-rank percentiles without retaining raw samples", () => {
    expect(summarizeMilliseconds([1, 2, 3, 4, 100])).toEqual({
      samples: 5,
      p50: 3,
      p95: 100,
      p99: 100,
    });
    expect(() => summarizeMilliseconds([])).toThrow("PILOT_LOAD_MEASUREMENTS_INVALID");
    expect(() => summarizeMilliseconds([1, Number.NaN])).toThrow("PILOT_LOAD_MEASUREMENTS_INVALID");
  });

  it("admits only zero-loss, zero-error, provider-disabled reports within all thresholds", () => {
    const passing = buildPilotReport(passingInput());
    expect(passing.ok).toBe(true);
    expect(validatePilotReport(passing)).toBe(passing);
    expect(JSON.stringify(passing)).not.toMatch(/email|cookie|token|roomCode|seatCode|messageText/i);

    for (const mutation of [
      { committedEventLoss: 1 },
      { duplicateCommittedEvents: 1 },
      { roomSeqGaps: 1 },
      { maxConcurrentClients: 49 },
      { reconnects: 49 },
      { errorRate: 0.01 },
      { textAckMs: metric(120, 751, 1_400) },
      { textAckMs: metric(120, 700, 1_501) },
      { outboxLagMs: metric(90, 1_001, 1_100) },
      { deterministicProjectionLagMs: metric(450, 3_001, 3_100, 20) },
      { providerChecks: { media: "UNEXPECTED_PROVIDER_AVAILABLE", agent: "AGENT_SERVICE_UNAVAILABLE" } },
      { backpressure: { snapshotRequired: 0, controlledCloses: 0 } },
    ]) {
      const failed = buildPilotReport({ ...passingInput(), ...mutation });
      expect(failed.ok).toBe(false);
      expect(validatePilotReport(failed)).toBe(failed);
    }
    expect(() => validatePilotReport({ ...passing, rooms: 9 })).toThrow("PILOT_LOAD_REPORT_INVALID");
    expect(() => validatePilotReport({ ...passing, teacherEmail: "forbidden@example.invalid" }))
      .toThrow("PILOT_LOAD_REPORT_INVALID");
  });

  it("derives only the run-owned disposable database identity without exposing its password", () => {
    const identity = derivePilotRunIdentity(
      "postgres://learning_orbit:opaque-password@127.0.0.1:55432/lo_pilot_0123456789abcdef_test",
    );
    expect(identity).toEqual({
      runId: "0123456789abcdef",
      teacherAddress: "pilot-0123456789abcdef@example.invalid",
    });
    expect(JSON.stringify(identity)).not.toContain("opaque-password");
    expect(() => derivePilotRunIdentity(
      "postgres://learning_orbit:opaque-password@127.0.0.1:5432/lo_pilot_0123456789abcdef_test",
    )).toThrow("PILOT_LOAD_DATABASE_URL_INVALID");
    expect(() => derivePilotRunIdentity(
      "postgres://learning_orbit:opaque-password@127.0.0.1:55432/shared_database",
    )).toThrow("PILOT_LOAD_DATABASE_URL_INVALID");
  });

  it("accepts only an opaque Secure HttpOnly SameSite session cookie", async () => {
    const token = "A".repeat(43);
    expect(extractOpaqueSessionCookie([
      `lo_session=${token}; Max-Age=28800; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ])).toBe(`lo_session=${token}`);
    expect(() => extractOpaqueSessionCookie([`lo_session=${token}; Path=/; Secure; SameSite=Lax`]))
      .toThrow("PILOT_LOAD_SESSION_COOKIE_INVALID");
    expect(() => extractOpaqueSessionCookie([`lo_session=${token}; Path=/; HttpOnly; Secure; SameSite=None`]))
      .toThrow("PILOT_LOAD_SESSION_COOKIE_INVALID");
    expect(() => new LocalHttpsClient()).toThrow("PILOT_LOAD_CA_REQUIRED");
    await expect(loadPilotCaFile("relative-cert.pem")).rejects.toThrow("PILOT_LOAD_CA_FILE_INVALID");
  });

  it("requires real provider-disabled server responses", () => {
    expect(assertProviderDisabled("media", 503, { code: "MEDIA_SERVICE_UNAVAILABLE" }))
      .toBe("MEDIA_SERVICE_UNAVAILABLE");
    expect(assertProviderDisabled("agent", 503, { code: "AGENT_SERVICE_UNAVAILABLE" }))
      .toBe("AGENT_SERVICE_UNAVAILABLE");
    expect(() => assertProviderDisabled("media", 201, { mediaId: "fixture" }))
      .toThrow("PILOT_LOAD_PROVIDER_BOUNDARY_FAILED");
    expect(() => assertProviderDisabled("agent", 202, { state: "queued" }))
      .toThrow("PILOT_LOAD_PROVIDER_BOUNDARY_FAILED");
  });

  it("places the opaque session only in the WSS Cookie header and tracks live concurrency", async () => {
    class FakeSocket extends EventEmitter {
      static instances: FakeSocket[] = [];
      url: string;
      options: Record<string, any>;
      sent: any[] = [];
      readyState = 1;
      _socket = { pause: () => undefined, resume: () => undefined };
      constructor(url: string, options: Record<string, any>) {
        super();
        this.url = url;
        this.options = options;
        FakeSocket.instances.push(this);
        queueMicrotask(() => this.emit("open"));
      }
      send(text: string) {
        const frame = JSON.parse(text);
        this.sent.push(frame);
        if (frame.type === "hello") queueMicrotask(() => {
          this.emit("message", JSON.stringify({ type: "welcome", roomId: ROOM_ID, cursor: 0, status: "scheduled", serverTime: "2026-08-31T00:00:00.000Z" }), false);
          this.emit("message", JSON.stringify({ type: "resume_complete", throughRoomSeq: 0 }), false);
        });
        if (frame.type === "command") queueMicrotask(() => this.emit("message", JSON.stringify({
          type: "ack", commandId: frame.command.commandId, roomSeq: 1, revision: 1,
        }), false));
      }
      close(code = 1000) {
        this.readyState = 3;
        queueMicrotask(() => this.emit("close", code, Buffer.alloc(0)));
      }
    }
    const ROOM_ID = "00000000-0000-4000-8000-000000000001";
    const cookie = `lo_session=${"A".repeat(43)}`;
    const tracker = new LoadConnectionTracker();
    const contracts = {
      routes: { rooms: { websocket: (roomId: string) => `/v1/rooms/${roomId}/realtime` } },
      realtimeContract: {
        encodeClientFrame: (value: unknown) => JSON.stringify(value),
        parseServerFrame: (value: unknown) => value,
      },
    };
    const client = new PilotWebSocketClient({
      roomId: ROOM_ID,
      cookie,
      clientId: "00000000-0000-4000-8000-000000000002",
      contracts,
      WebSocketImpl: FakeSocket,
      tracker,
      ca: Buffer.from("unit-test-ca"),
    });
    await client.connect(0);
    expect(FakeSocket.instances[0]!.url).toBe(`wss://127.0.0.1:3000/v1/rooms/${ROOM_ID}/realtime`);
    expect(new URL(FakeSocket.instances[0]!.url).search).toBe("");
    expect(FakeSocket.instances[0]!.options).toMatchObject({
      origin: "https://127.0.0.1:3000",
      rejectUnauthorized: true,
      headers: { Cookie: cookie },
    });
    expect(tracker).toMatchObject({ active: 1, maximum: 1 });
    const command = {
      commandId: "00000000-0000-4000-8000-000000000003",
      roomId: ROOM_ID,
      type: "room.open",
      clientTime: "2026-08-31T00:00:00.000Z",
      payload: {},
    };
    await expect(client.sendCommand(command)).resolves.toMatchObject({
      roomSeq: 1,
      revision: 1,
      latencyMs: expect.any(Number),
    });
    await client.close();
    expect(tracker).toMatchObject({ active: 0, maximum: 1 });
  });
});
