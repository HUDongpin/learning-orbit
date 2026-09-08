#!/usr/bin/env -S pnpm tsx
/**
 * Check a governance record against the deployment-controlled trust set.
 *
 * Reads nothing but the record and the trust set, writes nothing, and touches
 * no database: an operator can run it on a record before deciding whether to
 * import it.
 *
 * The signature and the key are the first question and never the whole one.
 * A signature proves who wrote the bytes; it says nothing about what the bytes
 * say, and the two Gate 6 records that admit real students carry their own
 * refusal conditions in their payloads — a rehearsal, an approval the operating
 * party issued to itself, a promotion inferred from the shadow it is supposed
 * to be independent of. Those live in the shared contract, so for those kinds
 * the payload is re-parsed through it here rather than trusted because it was
 * signed. The kind's contract is named in the output so a caller can refuse a
 * record whose payload nothing checked.
 *
 *   pnpm tsx scripts/verify-controlled-authority.ts --record <file> --trust <file>
 *   pnpm tsx scripts/verify-controlled-authority.ts --fixture
 */
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { argv, env, exit, stderr, stdout } from "node:process";

import {
  externalAuthorizationRecordContract,
  studentVisiblePromotionRecordContract,
} from "@learning-orbit/contracts";

import {
  authoritySigningInput,
  ControlledAuthorityError,
  parseAuthorityTrustSet,
  parseSignedAuthorityRecord,
  trustSetHasNoRotationGap,
  verifyControlledAuthority,
  type AuthorityRecordKind,
} from "../apps/server/src/modules/authorization/controlled-authority-verifier.js";

/**
 * The payload contract each kind must satisfy before this tool reports it.
 *
 * Only the two records that open a classroom are listed. The others are the
 * business of the importer that owns them — `pilot_retention_policy` is parsed
 * by `import-approved-pilot-policy.ts` against the same shared contract, and
 * adding it here would only give one payload two opinions. A kind absent from
 * this table reports `payloadContract: null`, which is the honest answer and
 * not an endorsement: a caller that needs the payload checked must refuse it.
 */
const PAYLOAD_CONTRACTS: Partial<Record<AuthorityRecordKind, {
  readonly id: string;
  readonly parse: (value: unknown) => unknown;
}>> = Object.freeze({
  external_authorization: Object.freeze({
    id: "external-authorization-record.v1",
    parse: (value: unknown) => externalAuthorizationRecordContract.parse(value),
  }),
  student_visible_promotion: Object.freeze({
    id: "student-visible-promotion-record.v1",
    parse: (value: unknown) => studentVisiblePromotionRecordContract.parse(value),
  }),
});

/** A refusal is one bounded code; a governance payload is never echoed. */
const REFUSAL_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

function refusalCode(error: unknown, fallback: string): string {
  if (error instanceof ControlledAuthorityError) return error.code;
  // The contracts refuse with a bounded code as the message. Anything else may
  // be quoting the record it refused, so it is replaced rather than printed.
  const message = error instanceof Error ? error.message : "";
  return REFUSAL_CODE.test(message) ? message : fallback;
}

function option(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && typeof argv[index + 1] === "string") return argv[index + 1];
  return argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

/**
 * A self-contained example so the tool can be exercised without a real
 * authority key. It is refused unless the caller asks for fixtures explicitly,
 * and never in a production environment.
 */
function fixture() {
  if (env.NODE_ENV === "production") {
    stderr.write("fixture authority is forbidden in production\n");
    exit(2);
  }
  const pair = generateKeyPairSync("ed25519");
  const unsigned = {
    kind: "pilot_retention_policy" as const,
    recordId: randomUUID(),
    issuer: "fixture-authority",
    keyId: "fixture-key-1",
    signedAt: new Date(Date.now() - 86_400_000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    payload: { policyVersion: "synthetic-fixture", roomEventsDays: 30 },
  };
  const record = parseSignedAuthorityRecord(JSON.stringify({
    ...unsigned,
    signature: sign(null, authoritySigningInput(unsigned), pair.privateKey).toString("base64url"),
  }));
  const trust = parseAuthorityTrustSet(JSON.stringify({
    version: 1,
    keys: [{
      keyId: "fixture-key-1",
      issuer: "fixture-authority",
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      notBefore: new Date(Date.now() - 172_800_000).toISOString(),
      notAfter: new Date(Date.now() + 172_800_000).toISOString(),
      fixture: true,
    }],
  }));
  return { record, trust };
}

async function main(): Promise<void> {
  const useFixture = argv.includes("--fixture");
  let record;
  let trust;
  if (useFixture) {
    ({ record, trust } = fixture());
  } else {
    const recordPath = option("record");
    const trustPath = option("trust");
    if (!recordPath || !trustPath) {
      stderr.write("usage: verify-controlled-authority --record <file> --trust <file> | --fixture\n");
      exit(2);
      return;
    }
    try {
      record = parseSignedAuthorityRecord(await readFile(recordPath, "utf8"));
      trust = parseAuthorityTrustSet(await readFile(trustPath, "utf8"));
    } catch (error) {
      stderr.write(`${error instanceof ControlledAuthorityError ? error.code : "AUTHORITY_INPUT_UNREADABLE"}\n`);
      exit(1);
      return;
    }
  }

  // A gap between key windows is reported even when this record verifies: the
  // next record signed in that gap would look forged rather than merely late.
  const rotation = trustSetHasNoRotationGap(trust) ? "continuous" : "gapped";

  try {
    const verified = verifyControlledAuthority(record, trust, { allowFixtureKeys: useFixture });
    // Re-parsed through the shared contract rather than trusted because it was
    // signed: a correctly signed record can still declare itself a rehearsal,
    // or authorise more than it accounts for, and the operator should learn
    // that here rather than from the room it opened.
    const contract = PAYLOAD_CONTRACTS[verified.kind];
    if (contract) contract.parse(verified.payload);
    stdout.write(`${JSON.stringify({
      ok: true,
      kind: verified.kind,
      recordId: verified.recordId,
      issuer: verified.issuer,
      keyId: verified.keyId,
      signedAt: verified.signedAt,
      expiresAt: verified.expiresAt,
      payloadContract: contract?.id ?? null,
      fixture: useFixture,
      rotation,
    })}\n`);
  } catch (error) {
    stderr.write(`${refusalCode(error, "AUTHORITY_VERIFICATION_FAILED")}\n`);
    exit(1);
  }
}

void main();
