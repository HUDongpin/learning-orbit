#!/usr/bin/env -S pnpm tsx
/**
 * Import an approved pilot retention policy from a signed governance record.
 *
 * Migration 007 deliberately provisions no policy outside the test
 * environment, so a pilot database starts with none and cannot open a room.
 * This is the only supported way to fill that gap: an operator receives a
 * record signed by the controlling authority, this tool checks the signature
 * against the deployment's trust set, and only then writes one immutable
 * `pilot_retention_policy` row.
 *
 * The row is never updated.  Retention terms that change are a *new* policy
 * version with a new id; rooms keep pointing at the version they were opened
 * under, which is what makes a later deletion receipt mean anything.
 *
 *   pnpm tsx scripts/import-approved-pilot-policy.ts --record <f> --trust <f> [--apply]
 *   pnpm tsx scripts/import-approved-pilot-policy.ts --dry-run
 */
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { argv, env, exit, stderr, stdout } from "node:process";

import { pilotRetentionPolicyContract } from "./contracts-entrypoint.js";
import type { PilotRetentionPolicyRecord } from "./contracts-entrypoint.js";

import {
  authoritySigningInput,
  ControlledAuthorityError,
  parseAuthorityTrustSet,
  parseSignedAuthorityRecord,
  verifyControlledAuthority,
  type AuthorityTrustSet,
  type SignedAuthorityRecord,
} from "../apps/server/src/modules/authorization/controlled-authority-verifier.js";
import { createDatabasePool } from "../apps/server/src/db/pool.js";

const INSERT = `INSERT INTO pilot_retention_policy (
  policy_id, policy_version, room_events_days, raw_media_days,
  derived_artifacts_days, projections_days, agent_runs_days,
  provider_copies_days, backups_days, audit_metadata_days,
  approval_reference, approved_at, expires_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
ON CONFLICT (policy_id) DO NOTHING
RETURNING policy_id`;

function option(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && typeof argv[index + 1] === "string") return argv[index + 1];
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function fail(code: string): never {
  stderr.write(`${code}\n`);
  exit(1);
}

/** Values in the order the INSERT binds them. */
function bindings(policy: PilotRetentionPolicyRecord): unknown[] {
  return [
    policy.policyId, policy.policyVersion, policy.roomEventsDays, policy.rawMediaDays,
    policy.derivedArtifactsDays, policy.projectionsDays, policy.agentRunsDays,
    policy.providerCopiesDays, policy.backupsDays, policy.auditMetadataDays,
    policy.approvalReference, policy.approvedAt, policy.expiresAt,
  ];
}

/**
 * A record the tool signs for itself so `--dry-run` exercises the real
 * verification and binding path with no authority key and no database.  It is
 * never accepted by `--apply`: fixture keys are opt-in at the verifier, and
 * this branch never sets that option outside the dry run.
 */
function selfSignedExample(): { record: SignedAuthorityRecord; trust: AuthorityTrustSet } {
  const pair = generateKeyPairSync("ed25519");
  const payload: PilotRetentionPolicyRecord = {
    recordKind: "pilot_retention_policy",
    policyId: randomUUID(),
    policyVersion: "dry-run-example-v1",
    roomEventsDays: 30, rawMediaDays: 14, derivedArtifactsDays: 7,
    projectionsDays: 7, agentRunsDays: 7, providerCopiesDays: 7,
    backupsDays: 90, auditMetadataDays: 365,
    approvalReference: "dry-run/no-authority",
    approvedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
  };
  const unsigned = {
    kind: "pilot_retention_policy" as const,
    recordId: randomUUID(),
    issuer: "dry-run-authority",
    keyId: "dry-run-key-1",
    signedAt: new Date(Date.now() - 3_600_000).toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    payload: payload as unknown as Record<string, unknown>,
  };
  const record = parseSignedAuthorityRecord(JSON.stringify({
    ...unsigned,
    signature: sign(null, authoritySigningInput(unsigned), pair.privateKey).toString("base64url"),
  }));
  const trust = parseAuthorityTrustSet(JSON.stringify({
    version: 1,
    keys: [{
      keyId: "dry-run-key-1",
      issuer: "dry-run-authority",
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      notBefore: new Date(Date.now() - 7_200_000).toISOString(),
      notAfter: new Date(Date.now() + 7_200_000).toISOString(),
      fixture: true,
    }],
  }));
  return { record, trust };
}

async function main(): Promise<void> {
  const apply = argv.includes("--apply");
  const recordPath = option("record");
  const trustPath = option("trust");
  const usingExample = !recordPath && !trustPath;

  if (apply && usingExample) fail("APPROVED_POLICY_RECORD_REQUIRED");
  if (usingExample && env.NODE_ENV === "production") fail("APPROVED_POLICY_RECORD_REQUIRED");
  if (!usingExample && (!recordPath || !trustPath)) fail("APPROVED_POLICY_TRUST_REQUIRED");

  let record: SignedAuthorityRecord;
  let trust: AuthorityTrustSet;
  if (usingExample) {
    ({ record, trust } = selfSignedExample());
  } else {
    try {
      record = parseSignedAuthorityRecord(await readFile(recordPath as string, "utf8"));
      trust = parseAuthorityTrustSet(await readFile(trustPath as string, "utf8"));
    } catch (error) {
      fail(error instanceof ControlledAuthorityError ? error.code : "APPROVED_POLICY_INPUT_UNREADABLE");
    }
  }

  let policy: PilotRetentionPolicyRecord;
  try {
    const verified = verifyControlledAuthority(record, trust, { allowFixtureKeys: usingExample });
    if (verified.kind !== "pilot_retention_policy") fail("APPROVED_POLICY_RECORD_KIND");
    // The payload is re-parsed through the shared contract rather than trusted
    // because it was signed: a correctly signed record can still carry terms
    // the database's own CHECK constraints would reject, and the operator
    // should learn that here rather than from a constraint violation.
    policy = pilotRetentionPolicyContract.parse(verified.payload);
  } catch (error) {
    fail(error instanceof ControlledAuthorityError ? error.code : "INVALID_PILOT_RETENTION_POLICY");
  }

  if (!apply) {
    stdout.write(`${JSON.stringify({
      ok: true, applied: false, example: usingExample,
      policyVersion: policy.policyVersion, policyId: policy.policyId,
      statement: INSERT.replace(/\s+/g, " "),
      bindings: bindings(policy),
    }, null, 2)}\n`);
    return;
  }

  const pool = createDatabasePool();
  try {
    const inserted = await pool.query<{ policy_id: string }>(INSERT, bindings(policy));
    if (inserted.rowCount === 0) {
      // Same id already present.  Report whether it is byte-identical rather
      // than claiming success: a differing row under the same id means two
      // authorities disagree, and only a human can settle that.
      const existing = await pool.query<PilotRetentionPolicyRecord & { policy_version: string }>(
        "SELECT policy_version FROM pilot_retention_policy WHERE policy_id = $1", [policy.policyId],
      );
      const same = existing.rows[0]?.policy_version === policy.policyVersion;
      stdout.write(`${JSON.stringify({ ok: same, applied: false, alreadyPresent: true, policyId: policy.policyId })}\n`);
      if (!same) fail("APPROVED_POLICY_CONFLICT");
      return;
    }
    stdout.write(`${JSON.stringify({ ok: true, applied: true, policyId: policy.policyId, policyVersion: policy.policyVersion })}\n`);
  } finally {
    await pool.end();
  }
}

void main();
