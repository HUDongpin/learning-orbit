import { createPublicKey, verify, type KeyObject } from "node:crypto";

import { canonicalJson } from "../security/canonical-json.js";

/**
 * Verify a long-lived governance record.
 *
 * These are the records a human authority signs: the retention policy a school
 * approved, the provider-copy attestation, the completed teacher shadow, the
 * decision to show students their own analytics. They are nothing like the
 * short-lived service assertion a worker signs for one HTTP call, and this
 * verifier is deliberately separate from that one: they have different
 * lifetimes, different key custody, and different consequences if confused.
 * Neither accepts the other's record shape or key purpose.
 *
 * A record is trusted only when a currently valid, non-revoked, allowlisted key
 * signed exactly these bytes. Everything else - expiry, scope, what the record
 * then authorises - is the importer's business, not this function's.
 */

export const AUTHORITY_RECORD_KINDS = Object.freeze([
  "pilot_retention_policy",
  "provider_copy_authority",
  "engineering_ready",
  "external_authorization",
  "human_shadow_completed",
  "student_visible_promotion",
] as const);

export type AuthorityRecordKind = (typeof AUTHORITY_RECORD_KINDS)[number];

export class ControlledAuthorityError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface TrustedAuthorityKey {
  readonly keyId: string;
  readonly issuer: string;
  readonly publicKeyPem: string;
  /** ISO date-times bounding when this key may have signed. */
  readonly notBefore: string;
  readonly notAfter: string;
  readonly revokedAt?: string | null;
  /** A fixture key is usable only under an explicit test flag. */
  readonly fixture?: boolean;
}

export interface SignedAuthorityRecord {
  readonly kind: AuthorityRecordKind;
  readonly recordId: string;
  readonly issuer: string;
  readonly keyId: string;
  readonly signedAt: string;
  readonly expiresAt: string;
  /** Base64url Ed25519 signature over the canonical JSON of `payload`. */
  readonly signature: string;
  readonly payload: Record<string, unknown>;
}

export interface AuthorityTrustSet {
  readonly version: 1;
  readonly keys: readonly TrustedAuthorityKey[];
}

export interface VerifyOptions {
  /** Explicit opt-in before any fixture key may be used. Never true in a pilot. */
  readonly allowFixtureKeys?: boolean;
  readonly now?: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function fail(code: string): never {
  throw new ControlledAuthorityError(code);
}

function time(value: unknown, code: string): number {
  if (typeof value !== "string") fail(code);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) fail(code);
  return parsed;
}

/**
 * Parse the deployment-controlled trust set.
 *
 * Rotation must leave no gap: a record signed in the window between an old
 * key's expiry and a new key's start would verify against nothing, and the
 * authority would look forged rather than merely late.
 */
export function parseAuthorityTrustSet(source: string): AuthorityTrustSet {
  let document: unknown;
  try { document = JSON.parse(source); }
  catch { fail("AUTHORITY_TRUST_SET_INVALID"); }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    fail("AUTHORITY_TRUST_SET_INVALID");
  }
  const record = document as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.keys) || record.keys.length === 0) {
    fail("AUTHORITY_TRUST_SET_INVALID");
  }
  const seen = new Set<string>();
  const keys = record.keys.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail("AUTHORITY_TRUST_SET_INVALID");
    const key = entry as Record<string, unknown>;
    if (typeof key.keyId !== "string" || !KEY_ID.test(key.keyId) || seen.has(key.keyId)) {
      fail("AUTHORITY_TRUST_SET_INVALID");
    }
    if (typeof key.issuer !== "string" || key.issuer.length === 0 || key.issuer.length > 160) {
      fail("AUTHORITY_TRUST_SET_INVALID");
    }
    if (typeof key.publicKeyPem !== "string" || !key.publicKeyPem.includes("BEGIN PUBLIC KEY")) {
      fail("AUTHORITY_TRUST_SET_INVALID");
    }
    const notBefore = time(key.notBefore, "AUTHORITY_TRUST_SET_INVALID");
    const notAfter = time(key.notAfter, "AUTHORITY_TRUST_SET_INVALID");
    if (notAfter <= notBefore) fail("AUTHORITY_TRUST_SET_INVALID");
    if (key.revokedAt !== undefined && key.revokedAt !== null) time(key.revokedAt, "AUTHORITY_TRUST_SET_INVALID");
    if (key.fixture !== undefined && typeof key.fixture !== "boolean") fail("AUTHORITY_TRUST_SET_INVALID");
    seen.add(key.keyId);
    return Object.freeze({
      keyId: key.keyId,
      issuer: key.issuer,
      publicKeyPem: key.publicKeyPem,
      notBefore: key.notBefore as string,
      notAfter: key.notAfter as string,
      revokedAt: (key.revokedAt as string | null | undefined) ?? null,
      fixture: key.fixture === true,
    });
  });
  return Object.freeze({ version: 1, keys: Object.freeze(keys) });
}

/** True when the set's validity windows tile without a gap, per issuer. */
export function trustSetHasNoRotationGap(trust: AuthorityTrustSet): boolean {
  const byIssuer = new Map<string, TrustedAuthorityKey[]>();
  for (const key of trust.keys) {
    if (key.revokedAt) continue;
    const bucket = byIssuer.get(key.issuer) ?? [];
    bucket.push(key);
    byIssuer.set(key.issuer, bucket);
  }
  for (const bucket of byIssuer.values()) {
    const ordered = [...bucket].sort(
      (left, right) => Date.parse(left.notBefore) - Date.parse(right.notBefore),
    );
    for (let index = 1; index < ordered.length; index += 1) {
      if (Date.parse(ordered[index]!.notBefore) > Date.parse(ordered[index - 1]!.notAfter)) return false;
    }
  }
  return true;
}

function publicKeyOf(key: TrustedAuthorityKey): KeyObject {
  try { return createPublicKey(key.publicKeyPem); }
  catch { return fail("AUTHORITY_TRUST_SET_INVALID"); }
}

export function parseSignedAuthorityRecord(source: string): SignedAuthorityRecord {
  let document: unknown;
  try { document = JSON.parse(source); }
  catch { fail("AUTHORITY_RECORD_INVALID"); }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    fail("AUTHORITY_RECORD_INVALID");
  }
  const record = document as Record<string, unknown>;
  const expected = ["expiresAt", "issuer", "keyId", "kind", "payload", "recordId", "signature", "signedAt"];
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expected)) fail("AUTHORITY_RECORD_INVALID");
  if (!AUTHORITY_RECORD_KINDS.includes(record.kind as AuthorityRecordKind)) fail("AUTHORITY_RECORD_KIND");
  if (typeof record.recordId !== "string" || !UUID.test(record.recordId)) fail("AUTHORITY_RECORD_INVALID");
  if (typeof record.issuer !== "string" || typeof record.keyId !== "string" || !KEY_ID.test(record.keyId)) {
    fail("AUTHORITY_RECORD_INVALID");
  }
  if (typeof record.signature !== "string" || !BASE64URL.test(record.signature)) fail("AUTHORITY_RECORD_INVALID");
  const signedAt = time(record.signedAt, "AUTHORITY_RECORD_INVALID");
  const expiresAt = time(record.expiresAt, "AUTHORITY_RECORD_INVALID");
  if (expiresAt <= signedAt) fail("AUTHORITY_RECORD_INVALID");
  if (record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload)) {
    fail("AUTHORITY_RECORD_INVALID");
  }
  return Object.freeze(record as unknown as SignedAuthorityRecord);
}

export interface VerifiedAuthority {
  readonly kind: AuthorityRecordKind;
  readonly recordId: string;
  readonly issuer: string;
  readonly keyId: string;
  readonly signedAt: string;
  readonly expiresAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Verify one record against the trust set.
 *
 * Order matters and is deliberate: the key is resolved and judged before any
 * signature work, so a revoked or fixture key is refused for what it is rather
 * than for failing a check it might coincidentally pass.
 */
export function verifyControlledAuthority(
  record: SignedAuthorityRecord,
  trust: AuthorityTrustSet,
  options: VerifyOptions = {},
): VerifiedAuthority {
  const now = options.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("AUTHORITY_CLOCK_INVALID");

  const key = trust.keys.find(
    (candidate) => candidate.keyId === record.keyId && candidate.issuer === record.issuer,
  );
  if (!key) fail("AUTHORITY_KEY_NOT_ALLOWLISTED");
  if (key.revokedAt) fail("AUTHORITY_KEY_REVOKED");
  if (key.fixture && options.allowFixtureKeys !== true) fail("AUTHORITY_FIXTURE_KEY_FORBIDDEN");

  const signedAt = Date.parse(record.signedAt);
  if (signedAt < Date.parse(key.notBefore) || signedAt > Date.parse(key.notAfter)) {
    fail("AUTHORITY_KEY_NOT_VALID_AT_SIGNING_TIME");
  }
  if (Date.parse(record.expiresAt) <= now.getTime()) fail("AUTHORITY_RECORD_EXPIRED");

  let signature: Buffer;
  try { signature = Buffer.from(record.signature, "base64url"); }
  catch { return fail("AUTHORITY_SIGNATURE_INVALID"); }
  if (signature.length !== 64) fail("AUTHORITY_SIGNATURE_INVALID");

  // The signature covers the canonical bytes of the payload together with the
  // record's own identity, so a payload cannot be lifted onto another record.
  const signed = canonicalJson({
    kind: record.kind,
    recordId: record.recordId,
    issuer: record.issuer,
    keyId: record.keyId,
    signedAt: record.signedAt,
    expiresAt: record.expiresAt,
    payload: record.payload as never,
  });
  if (!verify(null, signed, publicKeyOf(key), signature)) fail("AUTHORITY_SIGNATURE_INVALID");

  return Object.freeze({
    kind: record.kind,
    recordId: record.recordId,
    issuer: record.issuer,
    keyId: record.keyId,
    signedAt: record.signedAt,
    expiresAt: record.expiresAt,
    payload: Object.freeze({ ...record.payload }),
  });
}

/** The exact bytes a signer must sign for this record. */
export function authoritySigningInput(
  record: Omit<SignedAuthorityRecord, "signature">,
): Uint8Array {
  return canonicalJson({
    kind: record.kind,
    recordId: record.recordId,
    issuer: record.issuer,
    keyId: record.keyId,
    signedAt: record.signedAt,
    expiresAt: record.expiresAt,
    payload: record.payload as never,
  });
}
