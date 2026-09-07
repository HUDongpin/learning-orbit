import { createHash, createPrivateKey, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

import type { JobClaimIdentity } from "../jobs/job-claim-authority.js";
import { canonicalJson, parseCanonicalJson, type CanonicalJsonValue } from "./canonical-json.js";

const ENVELOPE_KEYS = [
  "alg", "keyId", "issuer", "subject", "audience", "issuedAt", "expiresAt", "bodySha256", "signature",
] as const;
const PROTECTED_KEYS = ENVELOPE_KEYS.slice(0, -1);
const CLAIM_KEYS = [
  "jobId", "jobType", "roomId", "sourceEventId", "dedupeKey", "correlationId", "claimGeneration", "claimToken", "workerId",
] as const;
const MAX_ASSERTION_LENGTH = 16_384;
const MAX_FIELD_LENGTH = 1_024;
const MAX_CLOCK_SKEW_MS = 5_000;

type Envelope = Readonly<Record<(typeof ENVELOPE_KEYS)[number], string>>;
type TrustedRecord = Readonly<{ issuer: string; keyId: string; publicKey: KeyObject }>;

export type ServiceAssertionTrust = Readonly<{
  resolve(issuer: string, keyId: string): TrustedRecord | undefined;
}>;
export type ServiceAssertionExpected = Readonly<{
  audience: string;
  workerId: string;
  claim: JobClaimIdentity;
  maxClockSkewMs?: number;
}>;

export type ProviderHealthAssertionExpected = Readonly<{
  providerId: string;
  manifestSha256: string;
  audience?: string;
  maxClockSkewMs?: number;
}>;

export type ProviderHealthAssertionIdentity = Readonly<{
  issuer: string;
  keyId: string;
  providerId: string;
}>;

type TrustConfig = Readonly<{
  version: number;
  keys: ReadonlyArray<Readonly<{ issuer: string; keyId: string; publicKeyPem: string }>>;
}>;

function trustInvalid(): never {
  throw new Error("SERVICE_ASSERTION_TRUST_INVALID");
}

function assertionInvalid(): never {
  throw new Error("SERVICE_ASSERTION_INVALID");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedString(value: unknown, max = MAX_FIELD_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function trustKey(issuer: string, keyId: string): string {
  return `${issuer.length}:${issuer}${keyId.length}:${keyId}`;
}

function parsePublicEd25519Key(pem: string): KeyObject {
  if (!boundedString(pem, 16_384)) trustInvalid();
  try {
    createPrivateKey(pem);
    return trustInvalid();
  } catch (error) {
    if (error instanceof Error && error.message === "SERVICE_ASSERTION_TRUST_INVALID") throw error;
  }
  try {
    const publicKey = createPublicKey(pem);
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") trustInvalid();
    return publicKey;
  } catch (error) {
    if (error instanceof Error && error.message === "SERVICE_ASSERTION_TRUST_INVALID") throw error;
    return trustInvalid();
  }
}

export function createServiceAssertionTrust(config: unknown): ServiceAssertionTrust {
  try {
    canonicalJson(config);
  } catch {
    return trustInvalid();
  }
  if (!isObject(config) || Object.keys(config).length !== 2 || config.version !== 1 || !Array.isArray(config.keys)) trustInvalid();
  if (config.keys.length === 0 || config.keys.length > 256) throw new Error("SERVICE_ASSERTION_TRUST_NOT_CONFIGURED");
  const records = new Map<string, TrustedRecord>();
  for (const candidate of config.keys) {
    if (!isObject(candidate) || Object.keys(candidate).length !== 3) trustInvalid();
    const { issuer, keyId, publicKeyPem } = candidate;
    if (!boundedString(issuer) || !boundedString(keyId) || !boundedString(publicKeyPem, 16_384)) trustInvalid();
    const key = trustKey(issuer, keyId);
    if (records.has(key)) trustInvalid();
    records.set(key, Object.freeze({ issuer, keyId, publicKey: parsePublicEd25519Key(publicKeyPem) }));
  }
  return Object.freeze({
    resolve: (issuer: string, keyId: string): TrustedRecord | undefined => records.get(trustKey(issuer, keyId)),
  });
}

export function loadServiceAssertionTrust(options: Readonly<{ trustFile?: string }>): ServiceAssertionTrust {
  if (!options.trustFile) throw new Error("SERVICE_ASSERTION_TRUST_NOT_CONFIGURED");
  try {
    const text = readFileSync(options.trustFile, "utf8");
    if (Buffer.byteLength(text, "utf8") > 1_048_576) trustInvalid();
    return createServiceAssertionTrust(parseCanonicalJson(text));
  } catch (error) {
    if (error instanceof Error && (error.message === "SERVICE_ASSERTION_TRUST_NOT_CONFIGURED" || error.message === "SERVICE_ASSERTION_TRUST_INVALID")) throw error;
    return trustInvalid();
  }
}

function decodeBase64Url(value: unknown, maxLength = MAX_ASSERTION_LENGTH): Buffer {
  if (!boundedString(value, maxLength) || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) assertionInvalid();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) assertionInvalid();
  return decoded;
}

function closedEnvelope(value: CanonicalJsonValue): Envelope {
  if (!isObject(value) || Object.keys(value).length !== ENVELOPE_KEYS.length) assertionInvalid();
  for (const key of ENVELOPE_KEYS) if (!Object.hasOwn(value, key) || !boundedString(value[key])) assertionInvalid();
  if (Object.keys(value).some((key) => !ENVELOPE_KEYS.includes(key as (typeof ENVELOPE_KEYS)[number]))) assertionInvalid();
  const envelope = value as Record<(typeof ENVELOPE_KEYS)[number], string>;
  if (envelope.alg !== "Ed25519" || !/^[0-9a-f]{64}$/.test(envelope.bodySha256)) assertionInvalid();
  if (decodeBase64Url(envelope.signature, 128).length !== 64) assertionInvalid();
  return envelope;
}

function parseRfc3339Utc(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value);
  if (!match) assertionInvalid();
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time)) assertionInvalid();
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2])
    || date.getUTCDate() !== Number(match[3]) || date.getUTCHours() !== Number(match[4])
    || date.getUTCMinutes() !== Number(match[5]) || date.getUTCSeconds() !== Number(match[6])
  ) assertionInvalid();
  return time;
}

function protectedFields(envelope: Envelope): Record<string, string> {
  return Object.fromEntries(PROTECTED_KEYS.map((key) => [key, envelope[key]]));
}

function assertClaim(body: unknown, expected: ServiceAssertionExpected): JobClaimIdentity {
  // The caller must validate the complete body with its generated closed request schema first.
  // This shared verifier binds that complete body and only owns the common claim tuple.
  if (!isObject(body) || !boundedString(expected.audience) || !boundedString(expected.workerId) || expected.workerId !== expected.claim.workerId) assertionInvalid();
  for (const key of CLAIM_KEYS) {
    if (!Object.hasOwn(body, key) || body[key] !== expected.claim[key]) assertionInvalid();
  }
  return expected.claim;
}

function hashMatches(body: unknown, bodySha256: string): boolean {
  const actual = createHash("sha256").update(canonicalJson(body)).digest();
  const expected = Buffer.from(bodySha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export type ServiceAssertionEnvelopeExpected = Readonly<{
  audience: string;
  workerId?: string;
  maxClockSkewMs?: number;
}>;

/**
 * Verify that this exact body was signed by a trusted worker for this audience.
 *
 * This half owns everything an unauthenticated caller must not be able to
 * influence: trust resolution, the closed envelope, freshness, the Ed25519
 * signature and the canonical body hash. It deliberately knows nothing about
 * the request schema, so a route can complete it *before* running generated
 * validation and never let an unsigned caller reach a parser at all.
 *
 * The signed subject is returned rather than supplied, so a route learns which
 * worker signed instead of asserting it.
 */
export function verifyServiceAssertionEnvelope(
  raw: unknown,
  body: unknown,
  expected: ServiceAssertionEnvelopeExpected,
  trust: ServiceAssertionTrust,
  now: Date,
): string {
  try {
    if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime()) || typeof trust?.resolve !== "function") assertionInvalid();
    if (!boundedString(expected.audience)) assertionInvalid();
    const encoded = decodeBase64Url(raw);
    const parsed = parseCanonicalJson(encoded);
    const envelope = closedEnvelope(parsed);
    if (!Buffer.from(canonicalJson(parsed)).equals(encoded)) assertionInvalid();
    const record = trust.resolve(envelope.issuer, envelope.keyId);
    if (!record || envelope.audience !== expected.audience) assertionInvalid();
    if (expected.workerId !== undefined && envelope.subject !== expected.workerId) assertionInvalid();
    if (!boundedString(envelope.subject)) assertionInvalid();
    const issuedAt = parseRfc3339Utc(envelope.issuedAt);
    const expiresAt = parseRfc3339Utc(envelope.expiresAt);
    const skew = expected.maxClockSkewMs ?? 0;
    if (!Number.isSafeInteger(skew) || skew < 0 || skew > MAX_CLOCK_SKEW_MS || expiresAt - issuedAt < 1_000 || expiresAt - issuedAt > 60_000) assertionInvalid();
    if (issuedAt - now.getTime() > skew || now.getTime() - expiresAt > skew) assertionInvalid();
    if (!verify(null, canonicalJson(protectedFields(envelope)), record.publicKey, decodeBase64Url(envelope.signature, 128))) assertionInvalid();
    if (!hashMatches(body, envelope.bodySha256)) assertionInvalid();
    return envelope.subject;
  } catch {
    return assertionInvalid();
  }
}

/**
 * Bind an already-verified body to the worker-job claim it names. Callers that
 * cannot separate the two steps may still use it directly; it re-verifies the
 * envelope so no path loses a check.
 */
export function authorizeServiceAssertion(
  raw: unknown,
  body: unknown,
  expected: ServiceAssertionExpected,
  trust: ServiceAssertionTrust,
  now: Date,
): JobClaimIdentity {
  try {
    verifyServiceAssertionEnvelope(raw, body, expected, trust, now);
    return assertClaim(body, expected);
  } catch {
    return assertionInvalid();
  }
}

/**
 * Authorize the one non-room internal mutation: a short-lived provider health
 * probe.  It deliberately shares the closed envelope, canonical body hash,
 * Ed25519 trust, and time checks above, but has no worker-job claim fields.
 */
export function authorizeProviderHealthAssertion(
  raw: unknown,
  body: unknown,
  expected: ProviderHealthAssertionExpected,
  trust: ServiceAssertionTrust,
  now: Date,
): ProviderHealthAssertionIdentity {
  try {
    if (!(now instanceof Date) || !Number.isSafeInteger(now.getTime()) || typeof trust?.resolve !== "function") assertionInvalid();
    if (!boundedString(expected.providerId, 64) || !/^[a-z0-9._-]{1,64}$/.test(expected.providerId)
      || !/^[a-f0-9]{64}$/.test(expected.manifestSha256)) assertionInvalid();
    if (!isObject(body) || Object.keys(body).some((key) => [
      "jobId", "jobType", "roomId", "sourceEventId", "dedupeKey", "correlationId", "claimGeneration", "claimToken", "workerId",
    ].includes(key))) assertionInvalid();
    const encoded = decodeBase64Url(raw);
    const parsed = parseCanonicalJson(encoded);
    const envelope = closedEnvelope(parsed);
    if (!Buffer.from(canonicalJson(parsed)).equals(encoded)) assertionInvalid();
    const record = trust.resolve(envelope.issuer, envelope.keyId);
    const audience = expected.audience ?? "internal.agent.health";
    if (!record || envelope.audience !== audience || envelope.subject !== `provider-health-probe:${expected.providerId}`) assertionInvalid();
    const issuedAt = parseRfc3339Utc(envelope.issuedAt);
    const expiresAt = parseRfc3339Utc(envelope.expiresAt);
    const skew = expected.maxClockSkewMs ?? 0;
    if (!Number.isSafeInteger(skew) || skew < 0 || skew > MAX_CLOCK_SKEW_MS || expiresAt - issuedAt < 1_000 || expiresAt - issuedAt > 30_000) assertionInvalid();
    if (issuedAt - now.getTime() > skew || now.getTime() - expiresAt > skew) assertionInvalid();
    if (!verify(null, canonicalJson(protectedFields(envelope)), record.publicKey, decodeBase64Url(envelope.signature, 128))) assertionInvalid();
    if (!hashMatches(body, envelope.bodySha256)) assertionInvalid();
    return { issuer: record.issuer, keyId: record.keyId, providerId: expected.providerId };
  } catch {
    return assertionInvalid();
  }
}
