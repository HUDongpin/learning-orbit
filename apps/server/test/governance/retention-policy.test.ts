import { describe, expect, it } from "vitest";
import { assertPilotRetentionPolicy, makeDeletionReceipt } from "../../src/modules/governance/retention-policy.js";

const valid = {
  roomEventsDays: 30, rawMediaDays: 14, derivedArtifactsDays: 7,
  projectionsDays: 7, agentRunsDays: 7, providerCopiesDays: 7,
  backupsDays: 90, auditMetadataDays: 365,
};

describe("pilot retention policy", () => {
  it("enforces parent/dependent retention inequalities", () => {
    expect(() => assertPilotRetentionPolicy(valid)).not.toThrow();
    expect(() => assertPilotRetentionPolicy({ ...valid, roomEventsDays: 6 })).toThrow("RETENTION_PARENT_EXPIRES_BEFORE_DEPENDENT");
    expect(() => assertPilotRetentionPolicy({ ...valid, rawMediaDays: 6 })).toThrow("RETENTION_MEDIA_EXPIRES_BEFORE_DERIVATIVE");
    expect(() => assertPilotRetentionPolicy({ ...valid, providerCopiesDays: 8 })).toThrow("RETENTION_PROVIDER_COPY_OUTLIVES_SOURCE");
  });

  it("requires the complete content-free online receipt surface", () => {
    const surfaces = ["events", "media", "derivatives", "artifacts", "projections", "agent_runs", "caches", "provider_copies"] as const;
    expect(makeDeletionReceipt({ completedAt: "2026-08-30T00:00:00.000Z", surfacesVerified: surfaces })).toEqual({
      receiptVersion: 1, completedAt: "2026-08-30T00:00:00.000Z", surfacesVerified: [...surfaces].sort(),
    });
    expect(() => makeDeletionReceipt({ completedAt: "2026-08-30T00:00:00.000Z", surfacesVerified: ["events"] })).toThrow("DELETION_SURFACES_INCOMPLETE");
  });
});
