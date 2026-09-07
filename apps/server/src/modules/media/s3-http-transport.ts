import { createHash } from "node:crypto";

import { authorizationHeaders, presignUrl, EMPTY_PAYLOAD_SHA256, type S3Credentials } from "./s3-signature.js";
import type { S3MediaStoreTransport } from "./s3-media-store.js";
import type { StoreCallControl } from "./media-store.js";

export interface S3HttpTransportOptions {
  /** Origin only, e.g. `http://127.0.0.1:59000`. Path-style addressing. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly credentials: S3Credentials;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * What this transport proves against an S3-compatible store, measured rather
 * than assumed: exact-key HEAD is read-after-write, HEAD returns the stored
 * SHA-256, promotion is conditional, and the destination is written once.
 * Promotion delivers write-once through a precondition PUT precisely because a
 * server-side copy does not honour one on every such store.
 */
export const S3_HTTP_TRANSPORT_CAPABILITIES = Object.freeze({
  maxPresignMs: 5_000,
  maxUploadRequestMs: 120_000,
  maxSignerDbClockSkewMs: 5_000,
  maxPostAbortSettlementMs: 5_000,
  exactKeyHeadIsStronglyConsistent: true,
  strongChecksumHead: true,
  conditionalPromotion: true,
  writeOnceDestination: true,
});

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** The media schema caps an asset at 25 MiB; nothing larger may transit here. */
const MAX_OBJECT_BYTES = 26_214_400;

function hexFromBase64(value: string): string {
  const hex = Buffer.from(value, "base64").toString("hex");
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error("OBJECT_CHECKSUM_UNAVAILABLE");
  return hex;
}

/**
 * The real S3-compatible transport behind S3MediaStore.
 *
 * Everything it does is exact-key and strongly consistent by construction: it
 * never lists, never guesses, and treats a missing checksum as a failure
 * rather than trusting an ETag. That matters because the deletion receipt and
 * the promotion fence both rest on "this exact key holds these exact bytes",
 * and an ETag is not that for a multipart object.
 */
export class S3HttpTransport implements S3MediaStoreTransport {
  private readonly endpoint: string;
  private readonly bucket: string;
  private readonly credentials: S3Credentials;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: S3HttpTransportOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash
      || !BUCKET_PATTERN.test(options.bucket)
      || !options.credentials?.accessKeyId || !options.credentials?.secretAccessKey
      || !options.credentials?.region) {
      throw new Error("STORAGE_TRANSPORT_CONFIG_INVALID");
    }
    this.endpoint = endpoint.origin;
    this.bucket = options.bucket;
    this.credentials = { ...options.credentials };
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  #now(control: StoreCallControl): Date {
    return control.now?.() ?? new Date();
  }

  #path(objectKey: string): string {
    if (!objectKey || objectKey.includes("..") || objectKey.startsWith("/")) {
      throw new Error("OBJECT_KEY_INVALID");
    }
    return `/${this.bucket}/${objectKey}`;
  }

  async #send(
    control: StoreCallControl,
    method: string,
    objectKey: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const path = this.#path(objectKey);
    const headers = authorizationHeaders({
      method,
      endpoint: this.endpoint,
      path,
      headers: extraHeaders,
      payloadSha256: EMPTY_PAYLOAD_SHA256,
      credentials: this.credentials,
      now: this.#now(control),
    });
    return this.fetchImpl(`${this.endpoint}${path}`, {
      method,
      headers,
      signal: control.signal,
    });
  }

  async createUploadUrl(
    input: Parameters<S3MediaStoreTransport["createUploadUrl"]>[0],
    control: StoreCallControl,
  ) {
    const signedAt = this.#now(control);
    // The checksum is part of the signature, so a grant issued for one set of
    // bytes cannot be replayed to upload different ones.
    const { url, expiresAt } = presignUrl({
      method: "PUT",
      endpoint: this.endpoint,
      bucket: this.bucket,
      objectKey: input.objectKey,
      expiresSeconds: input.expiresSeconds,
      credentials: this.credentials,
      now: signedAt,
      signedHeaders: { "x-amz-checksum-sha256": input.checksumSha256Base64 },
    });
    return {
      url,
      requiredHeaders: { "x-amz-checksum-sha256": input.checksumSha256Base64 },
      signedAt,
      expiresAt,
    };
  }

  async createDownloadUrl(
    input: Parameters<S3MediaStoreTransport["createDownloadUrl"]>[0],
    control: StoreCallControl,
  ) {
    const signedAt = this.#now(control);
    const { url, expiresAt } = presignUrl({
      method: "GET",
      endpoint: this.endpoint,
      bucket: this.bucket,
      objectKey: input.objectKey,
      expiresSeconds: input.expiresSeconds,
      credentials: this.credentials,
      now: signedAt,
    });
    return { url, signedAt, expiresAt };
  }

  async stat(objectKey: string, control: StoreCallControl) {
    const response = await this.#send(control, "HEAD", objectKey, {
      "x-amz-checksum-mode": "ENABLED",
    });
    if (response.status === 404) throw new Error("MEDIA_NOT_FOUND");
    if (!response.ok) throw new Error("STORAGE_PROVIDER_UNAVAILABLE");
    const checksum = response.headers.get("x-amz-checksum-sha256");
    const length = Number(response.headers.get("content-length"));
    const etag = response.headers.get("etag");
    if (!checksum || !etag || !Number.isSafeInteger(length) || length < 0) {
      // Without a stored checksum the object's identity cannot be proven, and
      // the promotion fence is exactly an identity check.
      throw new Error("OBJECT_CHECKSUM_UNAVAILABLE");
    }
    return {
      objectKey,
      sizeBytes: length,
      sha256: hexFromBase64(checksum),
      detectedMime: response.headers.get("content-type") ?? "application/octet-stream",
      etag: etag.replaceAll('"', ""),
    };
  }

  /**
   * Promote staging bytes to their immutable destination key.
   *
   * Deliberately not a server-side copy. MinIO honours `If-None-Match: *` on a
   * direct PUT (412 on an existing key) but ignores it on a copy, which
   * overwrites silently - so a copy cannot deliver the write-once destination
   * this pipeline's capabilities claim. Reading the verified staging bytes and
   * writing them under the precondition the store actually enforces gives a
   * real guarantee instead of an asserted one. Objects are capped at 25 MiB by
   * the media schema, so the round trip is bounded.
   */
  async promoteStagingObject(
    input: Parameters<S3MediaStoreTransport["promoteStagingObject"]>[0],
    control: StoreCallControl,
  ) {
    const settled = await this.#destinationIfPresent(input.destinationKey, input.expectedSha256, control);
    if (settled) return settled;

    const source = await this.#send(control, "GET", input.stagingKey, {
      "if-match": input.sourceEtag,
    });
    if (source.status === 404) throw new Error("OBJECT_IDENTITY_CHANGED");
    if (source.status === 412) throw new Error("OBJECT_IDENTITY_CHANGED");
    if (!source.ok) throw new Error("STORAGE_PROVIDER_UNAVAILABLE");
    const bytes = Buffer.from(await source.arrayBuffer());
    if (bytes.byteLength > MAX_OBJECT_BYTES) throw new Error("OBJECT_IDENTITY_CHANGED");
    if (createHash("sha256").update(bytes).digest("hex") !== input.expectedSha256) {
      throw new Error("OBJECT_IDENTITY_CHANGED");
    }

    const written = await this.#put(control, input.destinationKey, bytes, {
      "if-none-match": "*",
      "x-amz-checksum-sha256": bytes.length
        ? Buffer.from(input.expectedSha256, "hex").toString("base64")
        : "",
      ...(source.headers.get("content-type")
        ? { "content-type": source.headers.get("content-type")! }
        : {}),
    });
    if (written.status === 412 || written.status === 409) {
      // Another attempt won the race. It is only legitimate if it wrote the
      // same bytes.
      const raced = await this.#destinationIfPresent(input.destinationKey, input.expectedSha256, control);
      if (raced) return raced;
      throw new Error("OBJECT_PROMOTION_MISMATCH");
    }
    if (!written.ok) throw new Error("STORAGE_PROVIDER_UNAVAILABLE");

    const promoted = await this.stat(input.destinationKey, control);
    if (promoted.sha256 !== input.expectedSha256) throw new Error("OBJECT_PROMOTION_MISMATCH");
    return "created" as const;
  }

  async #destinationIfPresent(
    destinationKey: string,
    expectedSha256: string,
    control: StoreCallControl,
  ): Promise<"already_present_same_hash" | null> {
    try {
      const existing = await this.stat(destinationKey, control);
      if (existing.sha256 !== expectedSha256) throw new Error("OBJECT_PROMOTION_MISMATCH");
      return "already_present_same_hash";
    } catch (error) {
      if (error instanceof Error && error.message === "MEDIA_NOT_FOUND") return null;
      throw error;
    }
  }

  async #put(
    control: StoreCallControl,
    objectKey: string,
    body: Buffer,
    extraHeaders: Record<string, string>,
  ): Promise<Response> {
    const path = this.#path(objectKey);
    const headers = authorizationHeaders({
      method: "PUT",
      endpoint: this.endpoint,
      path,
      headers: extraHeaders,
      payloadSha256: createHash("sha256").update(body).digest("hex"),
      credentials: this.credentials,
      now: this.#now(control),
    });
    return this.fetchImpl(`${this.endpoint}${path}`, {
      method: "PUT",
      headers,
      body: new Uint8Array(body),
      signal: control.signal,
    });
  }

  async deleteObjects(objectKeys: string[], control: StoreCallControl): Promise<void> {
    // Deleted one exact key at a time. A batch delete reports per-key results
    // in a body that must then be parsed to know what actually happened, and
    // the deletion receipt may not rest on a partially-read answer.
    for (const objectKey of objectKeys) {
      const response = await this.#send(control, "DELETE", objectKey);
      if (!response.ok && response.status !== 404) throw new Error("STORAGE_PROVIDER_UNAVAILABLE");
    }
    for (const objectKey of objectKeys) {
      const probe = await this.#send(control, "HEAD", objectKey);
      if (probe.status !== 404) throw new Error("STORAGE_DELETE_UNVERIFIED");
    }
  }
}
