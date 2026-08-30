import { describe, expect, it } from "vitest";
import { agentContract, realtimeContract } from "../src/index.js";

const ids = { roomId: "11111111-1111-4111-8111-111111111111", runId: "22222222-2222-4222-8222-222222222222" };

describe("agent contracts", () => {
  it("keeps a machine candidate separate from room messages", () => {
    expect(agentContract.parseRequest({ triggerEventId: ids.roomId })).toEqual({ triggerEventId: ids.roomId });
    expect(() => agentContract.parseRequest({ triggerEventId: ids.roomId, text: "candidate" })).toThrow();
  });
  it("requires closed moderation and current-state fields", () => {
    expect(() => agentContract.parseCurrent({ roomId: ids.roomId, run: null, serviceHealth: "healthy", agentEnabled: true, updatedAt: "2026-08-30T08:00:00Z", token: "secret" })).toThrow();
    expect(agentContract.parseCancel({})).toEqual({});
  });
  it("accepts safe agent status as a realtime extension and rejects secret fields", () => {
    const status = { type: "agent_status", roomId: ids.roomId, agentRunId: ids.runId, state: "streaming", serviceHealth: "healthy", agentEnabled: true, updatedAt: "2026-08-30T08:00:00Z", failureCode: null };
    expect(realtimeContract.parseRealtimeFrame(status)).toEqual(status);
    expect(() => realtimeContract.parseRealtimeFrame({ ...status, provider: "secret" })).toThrow();
  });
});
