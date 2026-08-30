import { createHash, randomUUID } from "node:crypto";

import {
  assertStoreCallControl,
  type MediaStore,
  type MediaStoreCapabilities,
  type StoreCallControl,
} from "./media-store.js";

export interface S3MediaStoreTransport {
  createUploadUrl(input: {
    objectKey: string;
    mime: string;
    sizeBytes: number;
    checksumSha256Base64: string;
    expiresSeconds: number;
  }, control: StoreCallControl): Promise<{
    url: string;
    requiredHeaders: { "x-amz-checksum-sha256": string };
    signedAt: Date;
    expiresAt: Date;
  }>;
  promoteStagingObject(input: {
    stagingKey: string;
    destinationKey: string;
    sourceEtag: string;
    expectedSha256: string;
    ifDestinationAbsent: true;
  }, control: StoreCallControl): Promise<"created" | "already_present_same_hash">;
  createDownloadUrl(input: { objectKey: string; expiresSeconds: number }, control: StoreCallControl): Promise<{
    url: string;
    signedAt: Date;
    expiresAt: Date;
  }>;
  stat(objectKey: string, control: StoreCallControl): Promise<{
    objectKey: string;
    sizeBytes: number;
    sha256: string;
    detectedMime: string;
    etag: string;
  }>;
  deleteObjects(objectKeys: string[], control: StoreCallControl): Promise<void>;
}

const defaultCapabilities: MediaStoreCapabilities = Object.freeze({
  maxPresignMs: 5_000,
  maxUploadRequestMs: 120_000,
  maxSignerDbClockSkewMs: 5_000,
  maxPostAbortSettlementMs: 5_000,
  exactKeyHeadIsStronglyConsistent: true,
  strongChecksumHead: true,
  conditionalPromotion: true,
  writeOnceDestination: true,
});

export interface S3MediaStoreOptions {
  readonly transport: S3MediaStoreTransport;
  readonly capabilities: MediaStoreCapabilities;
}

/**
 * Thin S3-compatible adapter. The AWS/MinIO command implementation is injected
 * so the state machine can be tested without credentials or network access.
 */
export class S3MediaStore implements MediaStore {
  readonly capabilities: MediaStoreCapabilities;
  private readonly transport: S3MediaStoreTransport;

  constructor(options: S3MediaStoreOptions) {
    const capabilities = options?.capabilities;
    if (!options?.transport || !capabilities
      || capabilities.exactKeyHeadIsStronglyConsistent !== true
      || capabilities.strongChecksumHead !== true
      || capabilities.conditionalPromotion !== true
      || capabilities.writeOnceDestination !== true
      || !Number.isFinite(capabilities.maxPresignMs) || capabilities.maxPresignMs < 1 || capabilities.maxPresignMs > 30_000
      || !Number.isFinite(capabilities.maxUploadRequestMs) || capabilities.maxUploadRequestMs < 1 || capabilities.maxUploadRequestMs > 300_000
      || !Number.isFinite(capabilities.maxSignerDbClockSkewMs) || capabilities.maxSignerDbClockSkewMs < 0 || capabilities.maxSignerDbClockSkewMs > 60_000
      || !Number.isFinite(capabilities.maxPostAbortSettlementMs) || capabilities.maxPostAbortSettlementMs < 0 || capabilities.maxPostAbortSettlementMs > 60_000) {
      throw new Error("STORAGE_CAPABILITIES_UNPROVEN");
    }
    this.transport = options.transport;
    this.capabilities = Object.freeze({ ...capabilities });
  }

  #requireTransport(): S3MediaStoreTransport {
    return this.transport;
  }

  async #transportCall<T>(control: StoreCallControl, work: (transport: S3MediaStoreTransport) => Promise<T>): Promise<T> {
    assertStoreCallControl(control);
    const transport = this.#requireTransport();
    try { return await work(transport); }
    catch (error) {
      if (control.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new Error("STORAGE_DEADLINE_EXCEEDED");
      }
      throw new Error("STORAGE_PROVIDER_UNAVAILABLE");
    }
  }

  async createUploadUrl(input: Parameters<MediaStore["createUploadUrl"]>[0], control: StoreCallControl) {
    return this.#transportCall(control, (transport) => transport.createUploadUrl(input, control));
  }

  async promoteStagingObject(input: Parameters<MediaStore["promoteStagingObject"]>[0], control: StoreCallControl) {
    return this.#transportCall(control, (transport) => transport.promoteStagingObject(input, control));
  }

  async createDownloadUrl(input: Parameters<MediaStore["createDownloadUrl"]>[0], control: StoreCallControl) {
    return this.#transportCall(control, (transport) => transport.createDownloadUrl(input, control));
  }

  async stat(objectKey: string, control: StoreCallControl) {
    return this.#transportCall(control, (transport) => transport.stat(objectKey, control));
  }

  async deleteObjects(objectKeys: string[], control: StoreCallControl) {
    return this.#transportCall(control, (transport) => transport.deleteObjects(objectKeys, control));
  }
}

/** A deterministic in-memory store used by server tests and local demos. */
export class MemoryMediaStore implements MediaStore {
  readonly capabilities = defaultCapabilities;
  readonly objects = new Map<string, { bytes: Buffer; mime: string; sha256: string; etag: string }>();
  readonly browserOrigin: string;

  constructor(browserOrigin = "http://127.0.0.1:59000") {
    this.browserOrigin = browserOrigin;
  }

  #check(control: StoreCallControl): void { assertStoreCallControl(control); }

  async createUploadUrl(input: Parameters<MediaStore["createUploadUrl"]>[0], control: StoreCallControl) {
    this.#check(control);
    const signedAt = control.now?.() ?? new Date();
    const expiresAt = new Date(signedAt.getTime() + input.expiresSeconds * 1_000);
    return {
      url: `${this.browserOrigin}/upload/${encodeURIComponent(input.objectKey)}?grant=${randomUUID()}`,
      requiredHeaders: { "x-amz-checksum-sha256": input.checksumSha256Base64 },
      signedAt,
      expiresAt,
    };
  }

  async promoteStagingObject(input: Parameters<MediaStore["promoteStagingObject"]>[0], control: StoreCallControl) {
    this.#check(control);
    const source = this.objects.get(input.stagingKey);
    if (!source || source.etag !== input.sourceEtag || source.sha256 !== input.expectedSha256) {
      throw new Error("OBJECT_IDENTITY_CHANGED");
    }
    const existing = this.objects.get(input.destinationKey);
    if (existing) {
      if (existing.sha256 === input.expectedSha256) return "already_present_same_hash" as const;
      throw new Error("OBJECT_PROMOTION_MISMATCH");
    }
    this.objects.set(input.destinationKey, { ...source });
    return "created" as const;
  }

  async createDownloadUrl(input: Parameters<MediaStore["createDownloadUrl"]>[0], control: StoreCallControl) {
    this.#check(control);
    if (!this.objects.has(input.objectKey)) throw new Error("MEDIA_NOT_FOUND");
    const signedAt = control.now?.() ?? new Date();
    return {
      url: `${this.browserOrigin}/download/${encodeURIComponent(input.objectKey)}?token=${randomUUID()}`,
      signedAt,
      expiresAt: new Date(signedAt.getTime() + input.expiresSeconds * 1_000),
    };
  }

  async stat(objectKey: string, control: StoreCallControl) {
    this.#check(control);
    const object = this.objects.get(objectKey);
    if (!object) throw new Error("MEDIA_NOT_FOUND");
    return { objectKey, sizeBytes: object.bytes.length, sha256: object.sha256, detectedMime: object.mime, etag: object.etag };
  }

  async deleteObjects(objectKeys: string[], control: StoreCallControl): Promise<void> {
    this.#check(control);
    objectKeys.forEach((key) => this.objects.delete(key));
  }

  put(objectKey: string, bytes: Uint8Array, mime = "application/octet-stream"): void {
    const data = Buffer.from(bytes);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const etag = createHash("md5").update(data).digest("hex");
    this.objects.set(objectKey, { bytes: data, mime, sha256, etag });
  }
}
