import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 for S3-compatible object stores.
 *
 * Hand-written against the published algorithm rather than pulled from an SDK:
 * the pilot needs presigned PUT/GET, a conditional copy and a checksum HEAD
 * against MinIO, and nothing else. One small implementation, exercised by its
 * own vectors, is easier to review than a dependency whose surface is a
 * hundred times what is used here.
 */

export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const EMPTY_PAYLOAD_SHA256 = createHash("sha256").update("").digest("hex");

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

/** RFC 3986 encoding. S3 signs `~` literally and `/` only inside a path. */
export function rfc3986(value: string, preserveSlash = false): string {
  const encoded = encodeURIComponent(value)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return preserveSlash ? encoded.replaceAll("%2F", "/") : encoded;
}

export function canonicalQueryString(query: Readonly<Record<string, string>>): string {
  return Object.keys(query)
    .sort()
    .map((key) => `${rfc3986(key)}=${rfc3986(query[key]!)}`)
    .join("&");
}

/** `20260907T193000Z` and its `20260907` date stamp. */
export function amzTimestamps(now: Date): { amzDate: string; dateStamp: string } {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("INVALID_SIGNING_TIME");
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, "")}`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(credentials: S3Credentials, dateStamp: string, service: string): Buffer {
  const date = createHmac("sha256", `AWS4${credentials.secretAccessKey}`).update(dateStamp).digest();
  const region = createHmac("sha256", date).update(credentials.region).digest();
  const scoped = createHmac("sha256", region).update(service).digest();
  return createHmac("sha256", scoped).update("aws4_request").digest();
}

export interface CanonicalRequestInput {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadSha256: string;
}

export function canonicalRequest(input: CanonicalRequestInput): {
  canonical: string;
  signedHeaders: string;
} {
  const headerNames = Object.keys(input.headers).map((name) => name.toLowerCase()).sort();
  const lowered = new Map(
    Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")]),
  );
  const canonicalHeaders = headerNames.map((name) => `${name}:${lowered.get(name)}\n`).join("");
  const signedHeaders = headerNames.join(";");
  const canonical = [
    input.method.toUpperCase(),
    rfc3986(input.path, true),
    canonicalQueryString(input.query),
    canonicalHeaders,
    signedHeaders,
    input.payloadSha256,
  ].join("\n");
  return { canonical, signedHeaders };
}

function credentialScope(dateStamp: string, credentials: S3Credentials, service: string): string {
  return `${dateStamp}/${credentials.region}/${service}/aws4_request`;
}

function signature(
  credentials: S3Credentials,
  service: string,
  amzDate: string,
  dateStamp: string,
  canonical: string,
): string {
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope(dateStamp, credentials, service),
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  return createHmac("sha256", signingKey(credentials, dateStamp, service)).update(stringToSign).digest("hex");
}

export interface PresignInput {
  readonly method: "GET" | "PUT";
  readonly endpoint: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly expiresSeconds: number;
  readonly credentials: S3Credentials;
  readonly now: Date;
  /** Headers the client must send verbatim; they become part of the signature. */
  readonly signedHeaders?: Readonly<Record<string, string>>;
  readonly service?: string;
}

/**
 * Build a presigned URL. The browser sends exactly the returned URL plus every
 * header in `signedHeaders`; changing either invalidates the signature, which
 * is how a grant for one object and checksum cannot be replayed for another.
 */
export function presignUrl(input: PresignInput): { url: string; expiresAt: Date } {
  if (!Number.isSafeInteger(input.expiresSeconds)
    || input.expiresSeconds < 1 || input.expiresSeconds > 604_800) {
    throw new Error("INVALID_PRESIGN_EXPIRY");
  }
  const service = input.service ?? "s3";
  const endpoint = new URL(input.endpoint);
  const { amzDate, dateStamp } = amzTimestamps(input.now);
  const path = input.bucket ? `/${input.bucket}/${input.objectKey}` : `/${input.objectKey}`;
  const headers: Record<string, string> = { host: endpoint.host, ...(input.signedHeaders ?? {}) };
  const signedHeaderNames = Object.keys(headers).map((name) => name.toLowerCase()).sort().join(";");
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.credentials.accessKeyId}/${credentialScope(dateStamp, input.credentials, service)}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": signedHeaderNames,
  };
  const { canonical } = canonicalRequest({
    method: input.method,
    path,
    query,
    headers,
    payloadSha256: UNSIGNED_PAYLOAD,
  });
  const signed = signature(input.credentials, service, amzDate, dateStamp, canonical);
  const url = new URL(endpoint.origin);
  url.pathname = path;
  url.search = `${canonicalQueryString(query)}&X-Amz-Signature=${signed}`;
  return {
    url: url.toString(),
    expiresAt: new Date(input.now.getTime() + input.expiresSeconds * 1_000),
  };
}

export interface AuthorizationInput {
  readonly method: string;
  readonly endpoint: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly payloadSha256: string;
  readonly credentials: S3Credentials;
  readonly now: Date;
  readonly service?: string;
}

/** Sign a request this process makes itself (HEAD, COPY, DELETE, bucket admin). */
export function authorizationHeaders(input: AuthorizationInput): Record<string, string> {
  const service = input.service ?? "s3";
  const endpoint = new URL(input.endpoint);
  const { amzDate, dateStamp } = amzTimestamps(input.now);
  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    host: endpoint.host,
    "x-amz-content-sha256": input.payloadSha256,
    "x-amz-date": amzDate,
  };
  const { canonical, signedHeaders } = canonicalRequest({
    method: input.method,
    path: input.path,
    query: input.query ?? {},
    headers,
    payloadSha256: input.payloadSha256,
  });
  const signed = signature(input.credentials, service, amzDate, dateStamp, canonical);
  return {
    ...headers,
    authorization: [
      `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope(dateStamp, input.credentials, service)}`,
      `SignedHeaders=${signedHeaders}`,
      `Signature=${signed}`,
    ].join(", "),
  };
}
