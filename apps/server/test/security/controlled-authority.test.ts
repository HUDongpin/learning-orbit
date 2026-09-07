import { generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  authoritySigningInput,
  parseAuthorityTrustSet,
  parseSignedAuthorityRecord,
  trustSetHasNoRotationGap,
  verifyControlledAuthority,
  type SignedAuthorityRecord,
} from "../../src/modules/authorization/controlled-authority-verifier.js";

const NOW = new Date("2026-08-30T08:00:00.000Z");

function keyPair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey,
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

function trustSet(entries: Array<Record<string, unknown>>) {
  return parseAuthorityTrustSet(JSON.stringify({ version: 1, keys: entries }));
}

function signedRecord(
  privateKey: ReturnType<typeof keyPair>["privateKey"],
  overrides: Record<string, unknown> = {},
): SignedAuthorityRecord {
  const unsigned = {
    kind: "pilot_retention_policy" as const,
    recordId: randomUUID(),
    issuer: "school-authority",
    keyId: "authority-2026",
    signedAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2027-08-01T00:00:00.000Z",
    payload: { policyVersion: "approved-2026", roomEventsDays: 30 },
    ...overrides,
  };
  const signature = sign(null, authoritySigningInput(unsigned), privateKey)
    .toString("base64url");
  return parseSignedAuthorityRecord(JSON.stringify({ ...unsigned, signature }));
}

const liveKey = (publicKeyPem: string, overrides: Record<string, unknown> = {}) => ({
  keyId: "authority-2026",
  issuer: "school-authority",
  publicKeyPem,
  notBefore: "2026-01-01T00:00:00.000Z",
  notAfter: "2027-01-01T00:00:00.000Z",
  ...overrides,
});

describe("controlled authority verifier", () => {
  it("accepts a record a currently valid allowlisted key signed", () => {
    const { privateKey, publicKeyPem } = keyPair();
    const verified = verifyControlledAuthority(
      signedRecord(privateKey), trustSet([liveKey(publicKeyPem)]), { now: NOW },
    );
    expect(verified).toMatchObject({
      kind: "pilot_retention_policy",
      issuer: "school-authority",
      keyId: "authority-2026",
    });
    expect(verified.payload).toEqual({ policyVersion: "approved-2026", roomEventsDays: 30 });
  });

  it("refuses a key that is not on the allowlist at all", () => {
    const signer = keyPair();
    const allowlisted = keyPair();
    expect(() => verifyControlledAuthority(
      signedRecord(signer.privateKey), trustSet([liveKey(allowlisted.publicKeyPem)]), { now: NOW },
    )).toThrow("AUTHORITY_SIGNATURE_INVALID");

    expect(() => verifyControlledAuthority(
      signedRecord(signer.privateKey, { keyId: "some-other-key" }),
      trustSet([liveKey(allowlisted.publicKeyPem)]),
      { now: NOW },
    )).toThrow("AUTHORITY_KEY_NOT_ALLOWLISTED");
  });

  it("refuses a revoked key for being revoked, before any signature work", () => {
    const { privateKey, publicKeyPem } = keyPair();
    expect(() => verifyControlledAuthority(
      signedRecord(privateKey),
      trustSet([liveKey(publicKeyPem, { revokedAt: "2026-06-01T00:00:00.000Z" })]),
      { now: NOW },
    )).toThrow("AUTHORITY_KEY_REVOKED");
  });

  it("refuses a fixture key unless a caller explicitly opts in", () => {
    const { privateKey, publicKeyPem } = keyPair();
    const fixtureTrust = trustSet([liveKey(publicKeyPem, { fixture: true })]);
    // A pilot must never reach this branch; a test may, and has to say so.
    expect(() => verifyControlledAuthority(signedRecord(privateKey), fixtureTrust, { now: NOW }))
      .toThrow("AUTHORITY_FIXTURE_KEY_FORBIDDEN");
    expect(verifyControlledAuthority(
      signedRecord(privateKey), fixtureTrust, { now: NOW, allowFixtureKeys: true },
    ).keyId).toBe("authority-2026");
  });

  it("refuses a record signed outside its key's validity window", () => {
    const { privateKey, publicKeyPem } = keyPair();
    expect(() => verifyControlledAuthority(
      signedRecord(privateKey, { signedAt: "2025-06-01T00:00:00.000Z" }),
      trustSet([liveKey(publicKeyPem)]),
      { now: NOW },
    )).toThrow("AUTHORITY_KEY_NOT_VALID_AT_SIGNING_TIME");
  });

  it("refuses a record that has expired, however good its signature", () => {
    const { privateKey, publicKeyPem } = keyPair();
    expect(() => verifyControlledAuthority(
      signedRecord(privateKey, {
        signedAt: "2026-02-01T00:00:00.000Z",
        expiresAt: "2026-03-01T00:00:00.000Z",
      }),
      trustSet([liveKey(publicKeyPem)]),
      { now: NOW },
    )).toThrow("AUTHORITY_RECORD_EXPIRED");
  });

  it("refuses a payload lifted onto another record", () => {
    const { privateKey, publicKeyPem } = keyPair();
    const original = signedRecord(privateKey);
    // The signature covers the record's own identity, so the same payload and
    // signature under a different recordId is not a different valid record.
    const lifted = parseSignedAuthorityRecord(JSON.stringify({
      ...original, recordId: randomUUID(),
    }));
    expect(() => verifyControlledAuthority(lifted, trustSet([liveKey(publicKeyPem)]), { now: NOW }))
      .toThrow("AUTHORITY_SIGNATURE_INVALID");
  });

  it("refuses a record whose kind is not one of the six", () => {
    const { privateKey } = keyPair();
    const unsigned = { ...signedRecord(privateKey), kind: "make_me_an_admin" };
    expect(() => parseSignedAuthorityRecord(JSON.stringify(unsigned)))
      .toThrow("AUTHORITY_RECORD_KIND");
  });

  it("refuses a trust set that is not closed and well formed", () => {
    const { publicKeyPem } = keyPair();
    for (const document of [
      "not json",
      JSON.stringify({ version: 2, keys: [liveKey(publicKeyPem)] }),
      JSON.stringify({ version: 1, keys: [] }),
      JSON.stringify({ version: 1, keys: [liveKey(publicKeyPem, { keyId: "Bad Key" })] }),
      JSON.stringify({ version: 1, keys: [liveKey(publicKeyPem, { publicKeyPem: "not a key" })] }),
      JSON.stringify({ version: 1, keys: [liveKey(publicKeyPem, { notAfter: "2025-01-01T00:00:00.000Z" })] }),
      JSON.stringify({ version: 1, keys: [liveKey(publicKeyPem), liveKey(publicKeyPem)] }),
    ]) {
      expect(() => parseAuthorityTrustSet(document)).toThrow("AUTHORITY_TRUST_SET_INVALID");
    }
  });

  it("detects a rotation that would leave a record verifiable by nothing", () => {
    const { publicKeyPem } = keyPair();
    const continuous = trustSet([
      liveKey(publicKeyPem, { keyId: "authority-2025", notBefore: "2025-01-01T00:00:00.000Z", notAfter: "2026-02-01T00:00:00.000Z" }),
      liveKey(publicKeyPem, { keyId: "authority-2026", notBefore: "2026-01-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:00.000Z" }),
    ]);
    const gapped = trustSet([
      liveKey(publicKeyPem, { keyId: "authority-2025", notBefore: "2025-01-01T00:00:00.000Z", notAfter: "2025-06-01T00:00:00.000Z" }),
      liveKey(publicKeyPem, { keyId: "authority-2026", notBefore: "2026-01-01T00:00:00.000Z", notAfter: "2027-01-01T00:00:00.000Z" }),
    ]);
    expect(trustSetHasNoRotationGap(continuous)).toBe(true);
    // A record signed in the gap would look forged rather than merely late.
    expect(trustSetHasNoRotationGap(gapped)).toBe(false);
  });
});
