import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JobClaimIdentity } from "../../src/modules/jobs/job-claim-authority.js";
import { canonicalJson } from "../../src/modules/security/canonical-json.js";
import {
  authorizeServiceAssertion,
  createServiceAssertionTrust,
  loadServiceAssertionTrust,
} from "../../src/modules/security/service-assertion.js";
import { ServiceAssertionFixtureIssuer } from "../fixtures/service-assertion-issuer.js";

const now = new Date("2026-08-30T08:00:00.000Z");
const claim: JobClaimIdentity = {
  jobId: "11111111-1111-4111-8111-111111111111",
  jobType: "room.auto-close.v1",
  roomId: "22222222-2222-4222-8222-222222222222",
  sourceEventId: null,
  dedupeKey: "room.auto-close.v1:11111111-1111-4111-8111-111111111111",
  correlationId: "33333333-3333-4333-8333-333333333333",
  claimGeneration: "1",
  claimToken: "44444444-4444-4444-8444-444444444444",
  workerId: "worker-test-1",
};
const body = (overrides: Partial<JobClaimIdentity> = {}): JobClaimIdentity => ({ ...claim, ...overrides });
const expected = { audience: "internal.rooms.autoClose", workerId: claim.workerId, claim };
const issuer = new ServiceAssertionFixtureIssuer();
const trust = createServiceAssertionTrust({
  version: 1,
  keys: [{ issuer: issuer.issuer, keyId: issuer.keyId, publicKeyPem: issuer.publicKeyPem }],
});

function signed(overrides: Partial<Parameters<ServiceAssertionFixtureIssuer["sign"]>[0]> = {}) {
  return issuer.sign({
    subject: claim.workerId,
    audience: expected.audience,
    body: body(),
    now,
    ...overrides,
  });
}

function invalid(run: () => unknown): void {
  try {
    run();
    throw new Error("expected authorization to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("SERVICE_ASSERTION_INVALID");
    expect((error as Error).message).not.toContain(claim.claimToken);
  }
}

describe("service assertions", () => {
  it("authorizes a canonical base64url envelope bound to its full claim", () => {
    const assertion = signed();
    expect(assertion.raw).not.toContain("{");
    expect(authorizeServiceAssertion(assertion.raw, body(), expected, trust, now)).toEqual(claim);
  });

  it("permits a signed closed route body with fields beyond the shared claim", () => {
    const routeBody = { ...body(), closesAt: "2026-08-30T08:30:00.000Z" };
    const assertion = signed({ body: routeBody });
    expect(authorizeServiceAssertion(assertion.raw, routeBody, expected, trust, now)).toEqual(claim);
  });

  it("does not expose a mutable trust allowlist", () => {
    expect("records" in trust).toBe(false);
    expect(Reflect.set(trust, "records", new Map())).toBe(false);
    expect(Reflect.set(trust, "resolve", () => undefined)).toBe(false);
    const record = trust.resolve(issuer.issuer, issuer.keyId);
    expect(record).toBeDefined();
    expect(Reflect.set(record!, "publicKey", generateKeyPairSync("ed25519").publicKey)).toBe(false);
    expect(authorizeServiceAssertion(signed().raw, body(), expected, trust, now)).toEqual(claim);
  });

  it("rejects every protected scope and claim binding change", () => {
    invalid(() => authorizeServiceAssertion(signed({ audience: "internal.other" }).raw, body(), expected, trust, now));
    invalid(() => authorizeServiceAssertion(signed({ subject: "other-worker" }).raw, body(), expected, trust, now));
    invalid(() => authorizeServiceAssertion(signed({ issuer: "unknown" }).raw, body(), expected, trust, now));
    invalid(() => authorizeServiceAssertion(signed({ keyId: "unknown" }).raw, body(), expected, trust, now));
    for (const key of Object.keys(claim) as Array<keyof JobClaimIdentity>) {
      const altered = key === "roomId"
        ? "55555555-5555-4555-8555-555555555555"
        : key === "sourceEventId"
          ? "66666666-6666-4666-8666-666666666666"
          : `${body()[key]}-changed`;
      const changedBody = body({ [key]: altered });
      invalid(() => authorizeServiceAssertion(signed({ body: changedBody }).raw, changedBody, expected, trust, now));
    }
    const nullRoomBody = body({ roomId: null });
    invalid(() => authorizeServiceAssertion(signed({ body: nullRoomBody }).raw, nullRoomBody, expected, trust, now));
    const otherWorkerBody = body({ workerId: "other-worker" });
    invalid(() => authorizeServiceAssertion(signed({ body: otherWorkerBody }).raw, otherWorkerBody, expected, trust, now));
    const otherClaim = { ...claim, workerId: "other-worker" };
    invalid(() => authorizeServiceAssertion(signed({ subject: "other-worker" }).raw, body(), {
      audience: expected.audience,
      workerId: "other-worker",
      claim: otherClaim,
    }, trust, now));
    // The appended route field was not present when this complete body was signed.
    invalid(() => authorizeServiceAssertion(signed().raw, { ...body(), extra: true }, expected, trust, now));
  });

  it("rejects expired, future, zero and excessive lifetimes", () => {
    invalid(() => authorizeServiceAssertion(signed({ now: new Date(now.getTime() - 61_000) }).raw, body(), expected, trust, now));
    invalid(() => authorizeServiceAssertion(signed({ now: new Date(now.getTime() + 1_000) }).raw, body(), expected, trust, now));
    invalid(() => authorizeServiceAssertion(signed({ lifetimeSeconds: 0 }).raw, body(), expected, trust, now));
    invalid(() => authorizeServiceAssertion(signed({ lifetimeSeconds: 61 }).raw, body(), expected, trust, now));
  });

  it("caps optional clock skew at five seconds", () => {
    invalid(() => authorizeServiceAssertion(signed().raw, body(), {
      ...expected,
      maxClockSkewMs: 5_001,
    }, trust, now));
    invalid(() => authorizeServiceAssertion(signed().raw, body(), {
      ...expected,
      maxClockSkewMs: Number.MAX_SAFE_INTEGER,
    }, trust, now));
  });

  it("rejects non-canonical raw values, extra/missing envelope keys and signature tampering", () => {
    const assertion = signed();
    invalid(() => authorizeServiceAssertion(`${assertion.raw}=`, body(), expected, trust, now));
    invalid(() => authorizeServiceAssertion(Buffer.from(JSON.stringify(assertion.envelope)).toString("base64url"), body(), expected, trust, now));
    const withoutSignature = { ...assertion.envelope };
    delete withoutSignature.signature;
    invalid(() => authorizeServiceAssertion(Buffer.from(canonicalJson(withoutSignature)).toString("base64url"), body(), expected, trust, now));
    const extra = { ...assertion.envelope, extra: "no" };
    invalid(() => authorizeServiceAssertion(Buffer.from(canonicalJson(extra)).toString("base64url"), body(), expected, trust, now));
    const replacement = assertion.envelope.signature[0] === "A" ? "B" : "A";
    const tampered = { ...assertion.envelope, signature: `${replacement}${assertion.envelope.signature.slice(1)}` };
    invalid(() => authorizeServiceAssertion(Buffer.from(canonicalJson(tampered)).toString("base64url"), body(), expected, trust, now));
    const duplicateJson = '{"alg":"Ed25519","keyId":"test-ed25519-1","issuer":"learning-orbit-test-worker","subject":"worker-test-1","audience":"internal.rooms.autoClose","issuedAt":"2026-08-30T08:00:00.000Z","expiresAt":"2026-08-30T08:01:00.000Z","bodySha256":"0000000000000000000000000000000000000000000000000000000000000000","signature":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","\\u0061lg":"Ed25519"}';
    invalid(() => authorizeServiceAssertion(Buffer.from(duplicateJson).toString("base64url"), body(), expected, trust, now));
  });
});

describe("service assertion trust", () => {
  const paths: string[] = [];
  afterEach(async () => {
    await Promise.all(paths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
  });

  it("has no implicit trust or private-key fallback", async () => {
    expect(() => loadServiceAssertionTrust({})).toThrow("SERVICE_ASSERTION_TRUST_NOT_CONFIGURED");
    expect(() => createServiceAssertionTrust({ version: 1, keys: [] })).toThrow("SERVICE_ASSERTION_TRUST_NOT_CONFIGURED");
    const privatePair = generateKeyPairSync("ed25519");
    expect(() => createServiceAssertionTrust({ version: 1, keys: [
      { issuer: issuer.issuer, keyId: issuer.keyId, publicKeyPem: privatePair.privateKey.export({ format: "pem", type: "pkcs8" }).toString() },
    ] })).toThrow("SERVICE_ASSERTION_TRUST_INVALID");
    const wrongTypePair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => createServiceAssertionTrust({ version: 1, keys: [
      { issuer: issuer.issuer, keyId: issuer.keyId, publicKeyPem: wrongTypePair.publicKey.export({ format: "pem", type: "spki" }).toString() },
    ] })).toThrow("SERVICE_ASSERTION_TRUST_INVALID");
  });

  it("loads only closed, unique public Ed25519 trust files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "learning-orbit-trust-"));
    paths.push(directory);
    const trustFile = join(directory, "trust.json");
    await writeFile(trustFile, JSON.stringify({ version: 1, keys: [
      { issuer: issuer.issuer, keyId: issuer.keyId, publicKeyPem: issuer.publicKeyPem },
    ] }));
    expect(loadServiceAssertionTrust({ trustFile })).toBeDefined();
    await writeFile(trustFile, JSON.stringify({ version: 1, keys: [
      { issuer: issuer.issuer, keyId: issuer.keyId, publicKeyPem: issuer.publicKeyPem, extra: true },
    ] }));
    expect(() => loadServiceAssertionTrust({ trustFile })).toThrow("SERVICE_ASSERTION_TRUST_INVALID");
    await writeFile(trustFile, JSON.stringify({ version: 1 }));
    expect(() => loadServiceAssertionTrust({ trustFile })).toThrow("SERVICE_ASSERTION_TRUST_INVALID");
    await writeFile(trustFile, JSON.stringify({ version: 1, keys: [
      { issuer: issuer.issuer, keyId: issuer.keyId, publicKeyPem: issuer.publicKeyPem },
      { issuer: issuer.issuer, keyId: issuer.keyId, publicKeyPem: issuer.publicKeyPem },
    ] }));
    expect(() => loadServiceAssertionTrust({ trustFile })).toThrow("SERVICE_ASSERTION_TRUST_INVALID");
  });
});
