import { describe, expect, it } from "vitest";
import { agentContract } from "../src/agent.js";

describe("agent provider health contract", () => {
  it("accepts bounded health probes and closed responses", () => {
    const request = { probeId: "11111111-1111-4111-8111-111111111111", providerId: "fixture", manifestSha256: "a".repeat(64), health: "healthy", checkedAt: "2026-08-30T08:00:00Z", reasonCode: null } as const;
    expect(agentContract.parseHealthRequest(request)).toEqual(request);
    expect(agentContract.parseHealthResponse({ status: "ignored_stale" })).toEqual({ status: "ignored_stale" });
    expect(() => agentContract.parseHealthRequest({ ...request, roomId: request.probeId })).toThrow();
  });
});
