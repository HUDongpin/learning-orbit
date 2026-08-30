import { describe, expect, it } from "vitest";
import commandSchema from "../schemas/room-command.v1.json" with { type: "json" };
import envelopeSchema from "../schemas/room-event-envelope.v1.json" with { type: "json" };
import httpSchema from "../schemas/room-http.v1.json" with { type: "json" };
import realtimeSchema from "../schemas/realtime-frame.v1.json" with { type: "json" };
import { makeSchemaAjv } from "../src/schema-ajv.js";
import { realtimeContract, routes } from "../src/index.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const laterUuid = "22222222-2222-4222-8222-222222222222";
const at = "2026-08-30T00:00:00.000Z";

function ajvWithRoomSchemas() {
  const ajv = makeSchemaAjv();
  ajv.addSchema(commandSchema);
  ajv.addSchema(envelopeSchema);
  ajv.addSchema(httpSchema);
  ajv.addSchema(realtimeSchema);
  return ajv;
}

function command(type: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { commandId: uuid, roomId: laterUuid, type, clientTime: at, payload, ...extra };
}

function event(actorKind: string, actorRole: string, payload: Record<string, unknown> = {}) {
  return {
    eventId: uuid, schemaVersion: 1, roomId: laterUuid, roomSeq: 1, type: "message.added",
    actorId: uuid, actorKind, actorRole, revision: 1, operation: "add", eventTime: at,
    ingestTime: at, causationId: uuid, correlationId: laterUuid, payload,
  };
}

describe("strict schema compilation and command behavior", () => {
  it("compiles every room schema under strict Ajv with cross-schema refs", () => {
    const ajv = ajvWithRoomSchemas();
    expect(ajv.getSchema(commandSchema.$id)).toBeDefined();
    expect(ajv.getSchema(envelopeSchema.$id)).toBeDefined();
    expect(ajv.getSchema(httpSchema.$id)).toBeDefined();
    expect(ajv.getSchema(realtimeSchema.$id)).toBeDefined();
  });

  it("closes commands and accepts literal add text/media alternatives", () => {
    const validate = ajvWithRoomSchemas().getSchema(commandSchema.$id)!;
    expect(validate(command("message.add", { text: "text", mentions: [], mediaIds: [], replyTo: null }))).toBe(true);
    expect(validate(command("message.add", { text: "   ", mentions: [], mediaIds: [uuid], replyTo: null }))).toBe(true);
    expect(validate(command("message.add", { text: "   ", mentions: [], mediaIds: [], replyTo: null }))).toBe(false);
    expect(validate(command("message.add", { text: "text", mentions: [], mediaIds: [], replyTo: null, agentRunId: uuid }))).toBe(false);
    expect(validate(command("message.add", { text: "text", mentions: [uuid, uuid], mediaIds: [], replyTo: null }))).toBe(false);
    expect(validate(command("message.add", { text: "text", mentions: [], mediaIds: ["not-a-uuid"], replyTo: null }))).toBe(false);
    expect(validate(command("room.open", { unexpected: true }))).toBe(false);
  });

  it("requires revision at the top level and closes revise and retract payloads", () => {
    const validate = ajvWithRoomSchemas().getSchema(commandSchema.$id)!;
    const revise = { messageId: uuid, text: "revised", replyTo: null, mentions: [] };
    expect(validate(command("message.revise", revise, { baseRevision: 1 }))).toBe(true);
    expect(validate(command("message.revise", { ...revise, mediaIds: [] }, { baseRevision: 1 }))).toBe(false);
    expect(validate(command("message.revise", { ...revise, baseRevision: 1 }))).toBe(false);
    expect(validate(command("message.retract", { messageId: uuid }, { baseRevision: 1 }))).toBe(true);
    expect(validate(command("message.retract", { messageId: uuid, text: "no" }, { baseRevision: 1 }))).toBe(false);
    expect(validate(command("message.retract", { messageId: uuid, baseRevision: 1 }))).toBe(false);
  });
});

describe("envelope, HTTP catalog, and realtime behavior", () => {
  it("enforces event grammar, metadata bounds, and every legal actor pairing", () => {
    const validate = ajvWithRoomSchemas().getSchema(envelopeSchema.$id)!;
    for (const [kind, role] of [["human", "teacher"], ["human", "student"], ["agent", "socratic_facilitator"], ["system", "room_clock"], ["system", "system_worker"]]) {
      expect(validate(event(kind, role))).toBe(true);
    }
    expect(validate(event("system", "teacher"))).toBe(false);
    expect(validate({ ...event("human", "teacher"), type: "Bad type", roomSeq: 0 })).toBe(false);
    expect(validate({ ...event("human", "teacher"), extra: true })).toBe(false);
  });

  it("keeps strict Ajv unknown-keyword failure while allowing its sole ingress annotation", () => {
    expect(() => makeSchemaAjv().compile({ type: "object", "x-unknown-contract-keyword": true })).toThrow();
    expect(() => makeSchemaAjv().compile({ type: "object", "x-learning-orbit-python-ingress": true })).not.toThrow();
  });

  it("resolves HTTP definitions and external RoomEventPage reference", () => {
    const ajv = ajvWithRoomSchemas();
    const page = ajv.getSchema(`${httpSchema.$id}#/$defs/RoomEventPage`)!;
    expect(page({ events: [event("human", "teacher")], throughRoomSeq: 1, nextAfterSeq: 1 })).toBe(true);
    expect(page({ events: Array.from({ length: 501 }, () => event("human", "teacher")), throughRoomSeq: 501 })).toBe(false);
    const details = ajv.getSchema(`${httpSchema.$id}#/$defs/RoomDetails`)!;
    expect(details({ roomId: uuid, topic: "Ecosystems", durationSeconds: 2700, status: "open", startsAt: at, closesAt: null, nova: { actorId: laterUuid, actorKind: "agent", actorRole: "socratic_facilitator", displayName: "Nova Agent" }, participants: Array.from({ length: 4 }, () => ({ actorId: uuid, pseudonym: "Explorer", actorKind: "human", actorRole: "student" })) })).toBe(true);
    expect(details({ roomId: uuid, topic: "Ecosystems", durationSeconds: 2701, status: "open", startsAt: at, closesAt: null, nova: { actorId: laterUuid, actorKind: "agent", actorRole: "socratic_facilitator", displayName: "Nova Agent" }, participants: [] })).toBe(false);
  });

  it("accepts client frames only through client encoding and enforces server semantics", () => {
    const validCommand = command("message.add", { text: "hello", mentions: [], mediaIds: [], replyTo: null });
    expect(realtimeContract.parseRealtimeFrame({ type: "hello", clientId: uuid, resumeFrom: 0 })).toMatchObject({ type: "hello" });
    expect(realtimeContract.encodeClientFrame({ type: "command", command: validCommand })).toContain("command");
    expect(() => realtimeContract.encodeClientFrame({ type: "welcome", serverTime: at, roomId: uuid, cursor: 0, status: "open" })).toThrow("INVALID_CLIENT_FRAME");
    expect(realtimeContract.parseRealtimeFrame({ type: "heartbeat", serverTime: at })).toMatchObject({ type: "heartbeat" });
    expect(() => realtimeContract.parseRealtimeFrame({ type: "reject", code: "NOT_A_CODE" })).toThrow("INVALID_REALTIME_FRAME");
    expect(() => realtimeContract.parseRealtimeFrame({ type: "degraded", scope: "analytics", code: "STUDENT_ANALYTICS_NOT_PROMOTED", updatedAt: at })).toThrow("INVALID_REALTIME_FRAME");
    expect(realtimeContract.parseRealtimeFrame({ type: "degraded", scope: "analytics", code: "STUDENT_ANALYTICS_NOT_PROMOTED", updatedAt: at, projectionKey: "echo.student_approved" })).toMatchObject({ type: "degraded" });
    expect(() => realtimeContract.parseRealtimeFrame({ type: "degraded", scope: "realtime", code: "X", updatedAt: at, projectionKey: "echo.student_approved" })).toThrow("INVALID_REALTIME_FRAME");
    expect(() => realtimeContract.parseRealtimeFrame({ type: "event", event: { ...event("human", "teacher"), providerDelta: true } })).toThrow("INVALID_REALTIME_FRAME");
  });

  it("covers every closed client and server frame branch", () => {
    const commandFrame = command("message.add", { text: "hello", mentions: [], mediaIds: [], replyTo: null });
    const frames = [
      { type: "hello", clientId: uuid, resumeFrom: 0 },
      { type: "command", command: commandFrame },
      { type: "presence", state: "active", clientSeq: 0 },
      { type: "typing", active: true, clientSeq: 1 },
      { type: "heartbeat" },
      { type: "welcome", serverTime: at, roomId: uuid, cursor: 0, status: "open" },
      { type: "ack", commandId: uuid, roomSeq: 1, revision: 1 },
      { type: "reject", commandId: uuid, code: "INVALID_COMMAND", retryable: false },
      { type: "event", event: event("human", "student", { messageId: uuid, text: "hello", replyTo: null, mentions: [], mediaIds: [] }) },
      { type: "presence", actorId: uuid, state: "away", expiresAt: at },
      { type: "typing", actorId: uuid, active: false, expiresAt: at },
      { type: "resume_complete", throughRoomSeq: 0 },
      { type: "snapshot_required", afterSeq: 0, throughRoomSeq: 1 },
      { type: "degraded", scope: "analytics", code: "ORDINARY_ANALYTICS_DELAY", updatedAt: at },
      { type: "heartbeat", serverTime: at },
    ];
    for (const frame of frames) expect(realtimeContract.parseRealtimeFrame(frame)).toEqual(frame);
    expect(() => realtimeContract.parseRealtimeFrame({ type: "presence", state: "active", clientSeq: 0, actorId: uuid })).toThrow("INVALID_REALTIME_FRAME");
    expect(() => realtimeContract.encodeRoomCommand({ ...commandFrame, type: "message.retract", payload: { messageId: uuid } })).toThrow("INVALID_ROOM_COMMAND");
  });

  it("builds encoded bounded event routes", () => {
    expect(routes.rooms.events("a/b", { afterSeq: 0, limit: 500 })).toBe("/v1/rooms/a%2Fb/events?afterSeq=0&limit=500");
    expect(() => routes.rooms.events("x", { afterSeq: -1 })).toThrow(new RangeError("afterSeq"));
    expect(() => routes.rooms.events("x", { afterSeq: Number.MAX_SAFE_INTEGER + 1 })).toThrow(new RangeError("afterSeq"));
    expect(() => routes.rooms.events("x", { limit: 501 })).toThrow(new RangeError("limit"));
    expect(() => routes.rooms.events("x", { limit: 1.5 })).toThrow(new RangeError("limit"));
  });
});
