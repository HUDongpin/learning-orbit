#!/usr/bin/env -S pnpm tsx
/**
 * Check a governance record against the deployment-controlled trust set.
 *
 * Reads nothing but the record and the trust set, writes nothing, and touches
 * no database: an operator can run it on a record before deciding whether to
 * import it, and its answer is about the signature and the key, never about
 * what the record would then authorise.
 *
 *   pnpm tsx scripts/verify-controlled-authority.ts --record <file> --trust <file>
 *   pnpm tsx scripts/verify-controlled-authority.ts --fixture
 */
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { argv, env, exit, stderr, stdout } from "node:process";

import {
  authoritySigningInput,
  ControlledAuthorityError,
  parseAuthorityTrustSet,
  parseSignedAuthorityRecord,
  trustSetHasNoRotationGap,
  verifyControlledAuthority,
} from "../apps/server/src/modules/authorization/controlled-authority-verifier.js";

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
    stdout.write(`${JSON.stringify({
      ok: true,
      kind: verified.kind,
      recordId: verified.recordId,
      issuer: verified.issuer,
      keyId: verified.keyId,
      signedAt: verified.signedAt,
      expiresAt: verified.expiresAt,
      fixture: useFixture,
      rotation,
    })}\n`);
  } catch (error) {
    stderr.write(`${error instanceof ControlledAuthorityError ? error.code : "AUTHORITY_VERIFICATION_FAILED"}\n`);
    exit(1);
  }
}

void main();
