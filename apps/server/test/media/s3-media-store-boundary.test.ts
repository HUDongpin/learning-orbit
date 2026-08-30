import { describe, expect, it, vi } from "vitest";

import { S3MediaStore, type S3MediaStoreTransport } from "../../src/modules/media/s3-media-store.js";

const control = () => ({
  signal: new AbortController().signal,
  deadline: new Date(Date.now() + 10_000),
});
const capabilities = {
  maxPresignMs: 5_000,
  maxUploadRequestMs: 120_000,
  maxSignerDbClockSkewMs: 5_000,
  maxPostAbortSettlementMs: 5_000,
  exactKeyHeadIsStronglyConsistent: true,
  strongChecksumHead: true,
  conditionalPromotion: true,
  writeOnceDestination: true,
};

describe("S3 media transport boundary", () => {
  it("wraps every unknown provider failure in one content-free storage error", async () => {
    const secretFailure = vi.fn(async () => { throw new Error("sdk endpoint credential secret"); });
    const transport = {
      createUploadUrl: secretFailure,
      promoteStagingObject: secretFailure,
      createDownloadUrl: secretFailure,
      stat: secretFailure,
      deleteObjects: secretFailure,
    } as unknown as S3MediaStoreTransport;
    const store = new S3MediaStore({ transport, capabilities });
    const calls = [
      () => store.createUploadUrl({ objectKey: "key", mime: "image/png", sizeBytes: 3, checksumSha256Base64: "x", expiresSeconds: 60 }, control()),
      () => store.promoteStagingObject({ stagingKey: "staging", destinationKey: "destination", sourceEtag: "etag", expectedSha256: "a".repeat(64), ifDestinationAbsent: true }, control()),
      () => store.createDownloadUrl({ objectKey: "key", expiresSeconds: 60 }, control()),
      () => store.stat("key", control()),
      () => store.deleteObjects(["key"], control()),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toThrow("STORAGE_PROVIDER_UNAVAILABLE");
      await expect(call()).rejects.not.toThrow("credential secret");
    }
  });

  it("rejects an already-aborted call before invoking the transport", async () => {
    const transport = { stat: vi.fn() } as unknown as S3MediaStoreTransport;
    const store = new S3MediaStore({ transport, capabilities });
    const controller = new AbortController();
    controller.abort();
    await expect(store.stat("key", { signal: controller.signal, deadline: new Date(Date.now() + 10_000) }))
      .rejects.toThrow("STORAGE_DEADLINE_EXCEEDED");
    expect(transport.stat).not.toHaveBeenCalled();
  });

  it("rejects transport construction without a complete reviewed capability manifest", () => {
    const transport = { stat: vi.fn() } as unknown as S3MediaStoreTransport;
    expect(() => new S3MediaStore({ transport } as never)).toThrow("STORAGE_CAPABILITIES_UNPROVEN");
    for (const field of [
      "exactKeyHeadIsStronglyConsistent", "strongChecksumHead", "conditionalPromotion", "writeOnceDestination",
    ] as const) {
      expect(() => new S3MediaStore({ transport, capabilities: { ...capabilities, [field]: false } }))
        .toThrow("STORAGE_CAPABILITIES_UNPROVEN");
    }
  });
});
