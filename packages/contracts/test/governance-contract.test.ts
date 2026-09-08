import { describe, expect, it } from "vitest";
import {
  deletionLifecycleContract,
  pilotRetentionPolicyContract,
  providerCopyAuthorityContract,
  routes,
} from "../src/index.js";

const uuid = "11111111-1111-4111-8111-111111111111";
/** Well-formed to `format: "date-time"`, unplaceable to `Date.parse`. */
const LEAP_SECOND = "2026-12-31T23:59:60Z";

function retentionPolicy(override: Record<string, unknown> = {}) {
  return {
    recordKind: "pilot_retention_policy",
    policyId: uuid,
    policyVersion: "pilot-2026-01",
    roomEventsDays: 30,
    rawMediaDays: 14,
    derivedArtifactsDays: 7,
    projectionsDays: 7,
    agentRunsDays: 7,
    providerCopiesDays: 7,
    backupsDays: 90,
    auditMetadataDays: 365,
    approvalReference: "school-board-001",
    approvedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2027-08-01T00:00:00.000Z",
    ...override,
  };
}

function copyAuthority(override: Record<string, unknown> = {}) {
  return {
    recordKind: "provider_copy_authority",
    authorityId: "authority-001",
    issuerId: "learning-orbit-test-only",
    keyId: "key-2026-01",
    providerId: "fixture",
    providerManifestSha256: "a".repeat(64),
    lifecycleMode: "no_persistent_copy_attested",
    region: "hk",
    purpose: "pilot-inference",
    scopeHash: "b".repeat(64),
    startsAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2027-08-01T00:00:00.000Z",
    recordSha256: "c".repeat(64),
    ...override,
  };
}

describe("pilot governance contracts", () => {
  it("accepts a closed retention policy and rejects unknown fields", () => {
    const policy = retentionPolicy();
    expect(pilotRetentionPolicyContract.parse(policy)).toEqual(policy);
    expect(() => pilotRetentionPolicyContract.parse(retentionPolicy({ learnerEmail: "secret" }))).toThrow("INVALID_PILOT_RETENTION_POLICY");
  });

  it("only permits explicit no-persistent-copy authority", () => {
    const authority = copyAuthority();
    expect(providerCopyAuthorityContract.parse(authority)).toEqual(authority);
    expect(() => providerCopyAuthorityContract.parse(copyAuthority({ secret: "do-not-store" }))).toThrow("INVALID_PROVIDER_COPY_AUTHORITY");
    expect(() => providerCopyAuthorityContract.parse(copyAuthority({ lifecycleMode: "delete_and_probe" }))).toThrow("INVALID_PROVIDER_COPY_AUTHORITY");
  });

  it("refuses a governance window bound that never happened", () => {
    // `format: "date-time"` admits a leap second; `Date.parse` cannot place
    // it, and NaN loses every comparison, so an expiry-after-start refusal
    // written as a bare `<=` would wave the record through.
    for (const field of ["approvedAt", "expiresAt"]) {
      expect(() => pilotRetentionPolicyContract.parse(retentionPolicy({ [field]: LEAP_SECOND })))
        .toThrow("INVALID_PILOT_RETENTION_POLICY");
    }
    for (const field of ["startsAt", "expiresAt"]) {
      expect(() => providerCopyAuthorityContract.parse(copyAuthority({ [field]: LEAP_SECOND })))
        .toThrow("INVALID_PROVIDER_COPY_AUTHORITY");
    }
  });

  it("keeps deletion receipt content-free and constrains status branches", () => {
    expect(deletionLifecycleContract.parseRequest({ confirmation: `DELETE ${uuid}` })).toEqual({ confirmation: `DELETE ${uuid}` });
    expect(deletionLifecycleContract.parseAccepted({ deletionJobId: uuid, status: "queued" })).toEqual({ deletionJobId: uuid, status: "queued" });
    expect(deletionLifecycleContract.parseStatus({ deletionJobId: uuid, status: "completed", receipt: {
      receiptVersion: 1,
      surfacesVerified: ["agent_runs", "artifacts", "caches", "derivatives", "events", "media", "projections", "provider_copies"],
      completedAt: "2026-08-30T00:00:00.000Z",
    } })).toHaveProperty("receipt.receiptVersion", 1);
    expect(() => deletionLifecycleContract.parseStatus({ deletionJobId: uuid, status: "completed", receipt: {
      receiptVersion: 1, surfacesVerified: ["events"], completedAt: "2026-08-30T00:00:00.000Z", roomTopic: "secret",
    } })).toThrow("INVALID_DELETION_STATUS");
    expect(routes.rooms.deletionStatus(uuid)).toBe(`/v1/rooms/${uuid}/deletion`);
    expect(routes.deletions.get(uuid)).toBe(`/v1/deletions/${uuid}`);
    expect(routes.deletions.forRoom(uuid)).toBe(`/v1/rooms/${uuid}/deletion`);
  });
});
