import { describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@learning-orbit/contracts";
import { createDownloadGrant, getMediaAttachment, validateStorageBrowserUrl, type MediaDeps } from "../../src/modules/media/media-service.js";
import { safeDerivativeObjectKey } from "../../src/modules/media/media-object-keys.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const MEDIA_ID = "00000000-0000-4000-8000-000000000701";
const ORIGIN = "https://storage.learning-orbit.test";
const DERIVATIVE_KEY = `rooms/${ROOM_ID}/derivative/${MEDIA_ID}/sanitized_image`;
const SHA256 = "a".repeat(64);
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
const asset = {
  mediaId: MEDIA_ID,
  roomId: ROOM_ID,
  ownerActorId: "00000000-0000-4000-8000-000000000001",
  kind: "image",
  state: "ready",
  originalFileName: "original.jpg",
  declaredMime: "image/jpeg",
  detectedMime: "image/jpeg",
  sizeBytes: 10,
  declaredSha256: "b".repeat(64),
  sha256: "b".repeat(64),
  altText: "池塘草圖",
  caption: null,
  objectKey: `rooms/${ROOM_ID}/original/${MEDIA_ID}`,
  failureCode: null,
  promotionCorrelationId: null,
  outcomeTransitionId: null,
  createdAt: new Date("2026-08-31T00:59:00.000Z"),
  updatedAt: new Date("2026-08-31T01:00:00.000Z"),
} as const;
const derivative = {
  mediaId: MEDIA_ID,
  roomId: ROOM_ID,
  kind: "sanitized_image",
  objectKey: DERIVATIVE_KEY,
  mime: "image/png",
  sizeBytes: 3,
  sha256: SHA256,
};
const signedDownload = (
  url: string,
  signedAt = new Date("2026-08-31T01:00:00.000Z"),
  expiresAt = new Date("2026-08-31T01:01:00.000Z"),
) => ({ url, signedAt, expiresAt });
const teacher: Extract<AuthSession, { role: "teacher" }> = {
  role: "teacher",
  teacherId: "00000000-0000-4000-8000-000000000001",
  actorId: "00000000-0000-4000-8000-000000000001",
};

describe("storage browser URL boundary", () => {
  it("shares the frozen singular derivative key and rejects plural drift", () => {
    expect(safeDerivativeObjectKey(ROOM_ID, MEDIA_ID, "sanitized_image")).toBe(DERIVATIVE_KEY);
    expect(DERIVATIVE_KEY).not.toContain("/derivatives/");
  });

  it("accepts only exact configured HTTPS or explicit loopback URLs without embedded credentials", () => {
    expect(validateStorageBrowserUrl(`${ORIGIN}/object?signature=opaque`, [ORIGIN])).toBe(`${ORIGIN}/object?signature=opaque`);
    expect(validateStorageBrowserUrl("http://127.0.0.1:59000/object", ["http://127.0.0.1:59000"]))
      .toBe("http://127.0.0.1:59000/object");
    for (const candidate of [
      "https://evil.example/object",
      "https://user:password@storage.learning-orbit.test/object",
      "http://storage.learning-orbit.test/object",
      "not a URL",
    ]) {
      expect(() => validateStorageBrowserUrl(candidate, [ORIGIN])).toThrow("STORAGE_ORIGIN_NOT_ALLOWED");
    }
  });

  it("never signs a ready original when the required safe derivative is absent", async () => {
    const store = { capabilities, stat: vi.fn(), createDownloadUrl: vi.fn() };
    const deps = {
      pool: { query: vi.fn(async () => ({ rowCount: 1, rows: [{ one: 1 }] })) },
      store,
      repo: { getMedia: vi.fn(async () => asset), getSafeDerivative: vi.fn(async () => null) },
      clock: { now: () => new Date("2026-08-31T01:00:00.000Z") },
      config: { storageBrowserOrigins: [ORIGIN] },
    } as unknown as MediaDeps;

    await expect(createDownloadGrant(deps, { principal: teacher, roomId: ROOM_ID, mediaId: MEDIA_ID }))
      .rejects.toMatchObject({ code: "MEDIA_NOT_READY" });
    expect(store.stat).not.toHaveBeenCalled();
    expect(store.createDownloadUrl).not.toHaveBeenCalled();
  });

  it("HEAD-verifies and signs only the canonical safe derivative key", async () => {
    const store = {
      capabilities,
      stat: vi.fn(async () => ({ objectKey: DERIVATIVE_KEY, sizeBytes: 3, sha256: SHA256, detectedMime: "image/png", etag: "immutable" })),
      createDownloadUrl: vi.fn(async () => signedDownload(`${ORIGIN}/private?signature=opaque`)),
    };
    const deps = {
      pool: { query: vi.fn(async () => ({ rowCount: 1, rows: [{ one: 1 }] })) },
      store,
      repo: { getMedia: vi.fn(async () => asset), getSafeDerivative: vi.fn(async () => derivative) },
      clock: { now: () => new Date("2026-08-31T01:00:00.000Z") },
      config: { storageBrowserOrigins: [ORIGIN] },
    } as unknown as MediaDeps;

    await expect(createDownloadGrant(deps, { principal: teacher, roomId: ROOM_ID, mediaId: MEDIA_ID }))
      .resolves.toMatchObject({ downloadUrl: expect.stringContaining("signature=opaque") });
    expect(store.stat).toHaveBeenCalledWith(DERIVATIVE_KEY, expect.any(Object));
    expect(store.createDownloadUrl).toHaveBeenCalledWith({ objectKey: DERIVATIVE_KEY, expiresSeconds: 60 }, expect.any(Object));
  });

  it("projects ready public metadata from the verified safe derivative rather than the original", async () => {
    const deps = {
      pool: { query: vi.fn(async () => ({ rowCount: 1, rows: [{ one: 1 }] })) },
      store: {
        capabilities,
        stat: vi.fn(async () => ({ objectKey: DERIVATIVE_KEY, sizeBytes: 3, sha256: SHA256, detectedMime: "image/png", etag: "immutable" })),
      },
      repo: { getMedia: vi.fn(async () => asset), getSafeDerivative: vi.fn(async () => derivative) },
      clock: { now: () => new Date("2026-08-31T01:00:00.000Z") },
      config: { storageBrowserOrigins: [ORIGIN] },
    } as unknown as MediaDeps;

    await expect(getMediaAttachment(deps, { principal: teacher, roomId: ROOM_ID, mediaId: MEDIA_ID }))
      .resolves.toMatchObject({ state: "ready", detectedMime: "image/png", sizeBytes: 3 });
  });

  it("rejects a mismatched derivative identity before signing", async () => {
    const store = {
      capabilities,
      stat: vi.fn(async () => ({ objectKey: DERIVATIVE_KEY, sizeBytes: 3, sha256: "b".repeat(64), detectedMime: "image/png", etag: "changed" })),
      createDownloadUrl: vi.fn(),
    };
    const deps = {
      pool: { query: vi.fn(async () => ({ rowCount: 1, rows: [{ one: 1 }] })) },
      store,
      repo: { getMedia: vi.fn(async () => asset), getSafeDerivative: vi.fn(async () => derivative) },
      clock: { now: () => new Date("2026-08-31T01:00:00.000Z") },
      config: { storageBrowserOrigins: [ORIGIN] },
    } as unknown as MediaDeps;
    await expect(createDownloadGrant(deps, { principal: teacher, roomId: ROOM_ID, mediaId: MEDIA_ID }))
      .rejects.toMatchObject({ code: "STORAGE_DERIVATIVE_IDENTITY_MISMATCH" });
    expect(store.createDownloadUrl).not.toHaveBeenCalled();
  });

  it.each([
    [new Date("2026-08-31T01:00:00.000Z"), new Date("2026-08-31T01:01:01.000Z")],
    [new Date("2026-08-31T00:59:54.000Z"), new Date("2026-08-31T01:00:54.000Z")],
    [new Date("2026-08-31T01:00:11.000Z"), new Date("2026-08-31T01:01:11.000Z")],
  ])("rejects a download signer outside the exact 60-second window (%s)", async (signedAt, expiresAt) => {
    const store = {
      capabilities,
      stat: vi.fn(async () => ({ objectKey: DERIVATIVE_KEY, sizeBytes: 3, sha256: SHA256, detectedMime: "image/png", etag: "immutable" })),
      createDownloadUrl: vi.fn(async () => signedDownload(`${ORIGIN}/private?signature=opaque`, signedAt, expiresAt)),
    };
    const deps = {
      pool: { query: vi.fn(async () => ({ rowCount: 1, rows: [{ one: 1 }] })) },
      store,
      repo: { getMedia: vi.fn(async () => asset), getSafeDerivative: vi.fn(async () => derivative) },
      clock: { now: () => new Date("2026-08-31T01:00:00.000Z") },
      config: { storageBrowserOrigins: [ORIGIN] },
    } as unknown as MediaDeps;
    await expect(createDownloadGrant(deps, { principal: teacher, roomId: ROOM_ID, mediaId: MEDIA_ID }))
      .rejects.toMatchObject({ code: "STORAGE_SIGNED_WINDOW_INVALID" });
  });

  it("rejects plural, cross-room, or wrong-kind derivative rows before storage use", async () => {
    for (const changed of [
      { objectKey: `rooms/${ROOM_ID}/derivatives/${MEDIA_ID}/sanitized_image` },
      { roomId: "00000000-0000-4000-8000-000000000099" },
      { kind: "playback_audio" as const },
    ]) {
      const store = { capabilities, stat: vi.fn(), createDownloadUrl: vi.fn() };
      const deps = {
        pool: { query: vi.fn(async () => ({ rowCount: 1, rows: [{ one: 1 }] })) },
        store,
        repo: { getMedia: vi.fn(async () => asset), getSafeDerivative: vi.fn(async () => ({ ...derivative, ...changed })) },
        clock: { now: () => new Date("2026-08-31T01:00:00.000Z") },
        config: { storageBrowserOrigins: [ORIGIN] },
      } as unknown as MediaDeps;
      await expect(createDownloadGrant(deps, { principal: teacher, roomId: ROOM_ID, mediaId: MEDIA_ID }))
        .rejects.toMatchObject({ code: "INVALID_MEDIA_STATE" });
      expect(store.stat).not.toHaveBeenCalled();
      expect(store.createDownloadUrl).not.toHaveBeenCalled();
    }
  });

  it("rejects a malicious download transport before a grant reaches the browser contract", async () => {
    const store = {
      capabilities,
      stat: vi.fn(async () => ({ objectKey: DERIVATIVE_KEY, sizeBytes: 3, sha256: SHA256, detectedMime: "image/png", etag: "immutable" })),
      createDownloadUrl: vi.fn(async () => signedDownload("https://user:password@storage.learning-orbit.test/private?secret=hidden")),
    };
    const deps = {
      pool: { query: vi.fn(async () => ({ rowCount: 1, rows: [{ one: 1 }] })) },
      store,
      repo: { getMedia: vi.fn(async () => asset), getSafeDerivative: vi.fn(async () => derivative) },
      clock: { now: () => new Date("2026-08-31T01:00:00.000Z") },
      config: { storageBrowserOrigins: [ORIGIN] },
    } as unknown as MediaDeps;

    await expect(createDownloadGrant(deps, { principal: teacher, roomId: ROOM_ID, mediaId: MEDIA_ID }))
      .rejects.toMatchObject({ code: "STORAGE_ORIGIN_NOT_ALLOWED" });
    expect(store.createDownloadUrl).toHaveBeenCalledOnce();
  });
});
