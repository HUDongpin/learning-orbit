import { describe, expect, it } from "vitest";
import { createCoreEventPayloadRegistry, EventPayloadRegistry } from "../src/event-payload-registry.js";

const payloadSchema = { type: "object", additionalProperties: false, required: ["messageId"], properties: { messageId: { type: "string" } } };
const uuid = "11111111-1111-4111-8111-111111111111";
const baseMessage = { messageId: uuid, text: "Agent summary", replyTo: null, mentions: [], mediaIds: [] };
describe("default-deny event payload registry", () => {
  it("rejects unknown types and duplicate registrations", () => {
    const registry = new EventPayloadRegistry().register("extension.sampled", payloadSchema);
    expect(() => registry.assert("other.sampled", {})).toThrow("UNKNOWN_EVENT_TYPE:other.sampled");
    expect(() => registry.register("extension.sampled", payloadSchema)).toThrow("EVENT_TYPE_ALREADY_REGISTERED:extension.sampled");
  });
  it("rejects unknown payload fields", () => {
    const registry = new EventPayloadRegistry().register("message.added", payloadSchema);
    expect(() => registry.assert("message.added", { messageId: "x", extra: true })).toThrow("INVALID_EVENT_PAYLOAD:message.added");
  });
  it("registers only explicit extensions and rejects malformed names", () => {
    const registry = new EventPayloadRegistry();
    expect(() => registry.register("not a namespace", payloadSchema)).toThrow("INVALID_EVENT_TYPE_NAME:not a namespace");
    registry.register("extension.sampled", { type: "object", additionalProperties: false });
    expect(() => registry.assert("extension.sampled", {})).not.toThrow();
  });
  it("allows Agent provenance only on message.added", () => {
    const registry = createCoreEventPayloadRegistry();
    const agentPayload = { ...baseMessage, agentRunId: uuid, sourceEventIds: [uuid], warningCodes: ["LOW_CONFIDENCE"] };
    expect(() => registry.assert("message.added", agentPayload)).not.toThrow();
    expect(() => registry.assert("message.revised", agentPayload)).toThrow("INVALID_EVENT_PAYLOAD:message.revised");
    expect(() => registry.assert("message.retracted", { messageId: uuid, agentRunId: uuid })).toThrow("INVALID_EVENT_PAYLOAD:message.retracted");
  });
  it("enforces source and warning cardinality, uniqueness, and warning bounds", () => {
    const registry = createCoreEventPayloadRegistry();
    expect(() => registry.assert("message.added", { ...baseMessage, sourceEventIds: Array.from({ length: 31 }, () => uuid) })).toThrow("INVALID_EVENT_PAYLOAD:message.added");
    expect(() => registry.assert("message.added", { ...baseMessage, sourceEventIds: [uuid, uuid] })).toThrow("INVALID_EVENT_PAYLOAD:message.added");
    expect(() => registry.assert("message.added", { ...baseMessage, warningCodes: [""] })).toThrow("INVALID_EVENT_PAYLOAD:message.added");
    expect(() => registry.assert("message.added", { ...baseMessage, warningCodes: ["same", "same"] })).toThrow("INVALID_EVENT_PAYLOAD:message.added");
  });
});
