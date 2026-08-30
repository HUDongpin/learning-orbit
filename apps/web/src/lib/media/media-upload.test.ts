import { describe, expect, it, vi } from "vitest";

import { uploadMediaFile } from "./media-upload.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const MEDIA_ID = "00000000-0000-4000-8000-000000000701";
const HASH = {
  hex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  base64: "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
};

describe("real media grant/upload/complete pipeline", () => {
  it("uses the generated grant header byte-for-byte and exposes no signed URL", async () => {
    const file = new File(["abc"], "pond.png", { type: "image/png" });
    const gateway = {
      createMediaUpload: vi.fn(async () => ({
        mediaId: MEDIA_ID,
        uploadUrl: "https://storage.learning-orbit.test/signed-put?secret=hidden",
        requiredHeaders: { "x-amz-checksum-sha256": HASH.base64 },
        expiresAt: "2026-08-31T01:05:00.000Z",
      })),
      completeMediaUpload: vi.fn(async () => ({ mediaId: MEDIA_ID, state: "processing" as const, enqueued: true })),
      getMedia: vi.fn(),
      getMediaDownloadGrant: vi.fn(),
    };
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    const result = await uploadMediaFile({
      roomId: ROOM_ID,
      file,
      kind: "image",
      altText: "池塘草圖",
      caption: null,
      gateway,
      allowedUploadOrigins: ["https://storage.learning-orbit.test"],
      fetch: put,
      hash: vi.fn(async () => HASH),
      validateImage: vi.fn(async () => undefined),
      now: () => new Date("2026-08-31T01:00:00.000Z"),
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ mediaId: MEDIA_ID, state: "processing" });
    expect(gateway.createMediaUpload).toHaveBeenCalledWith(ROOM_ID, expect.objectContaining({
      kind: "image", mime: "image/png", sizeBytes: 3, sha256: HASH.hex, altText: "池塘草圖",
    }));
    expect(put).toHaveBeenCalledWith("https://storage.learning-orbit.test/signed-put?secret=hidden", {
      method: "PUT",
      body: file,
      headers: { "x-amz-checksum-sha256": HASH.base64 },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(result)).not.toContain("signed-put");
    expect(gateway.completeMediaUpload).toHaveBeenCalledWith(ROOM_ID, MEDIA_ID);
  });

  it("fails before PUT/finalize for an expired, hostile-origin, or checksum-mismatched grant", async () => {
    const file = new File(["abc"], "pond.png", { type: "image/png" });
    const put = vi.fn();
    for (const grant of [
      { uploadUrl: "https://storage.learning-orbit.test/put", requiredHeaders: { "x-amz-checksum-sha256": HASH.base64 }, expiresAt: "2026-08-31T00:59:59.000Z" },
      { uploadUrl: "https://evil.example/put", requiredHeaders: { "x-amz-checksum-sha256": HASH.base64 }, expiresAt: "2026-08-31T01:05:00.000Z" },
      { uploadUrl: "https://user:password@storage.learning-orbit.test/put", requiredHeaders: { "x-amz-checksum-sha256": HASH.base64 }, expiresAt: "2026-08-31T01:05:00.000Z" },
      { uploadUrl: "https://storage.learning-orbit.test/put", requiredHeaders: { "x-amz-checksum-sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }, expiresAt: "2026-08-31T01:05:00.000Z" },
    ]) {
      const gateway = {
        createMediaUpload: vi.fn(async () => ({ mediaId: MEDIA_ID, ...grant })),
        completeMediaUpload: vi.fn(), getMedia: vi.fn(), getMediaDownloadGrant: vi.fn(),
      };
      await expect(uploadMediaFile({
        roomId: ROOM_ID, file, kind: "image", altText: "池塘", caption: null, gateway,
        allowedUploadOrigins: ["https://storage.learning-orbit.test"], fetch: put,
        hash: vi.fn(async () => HASH), validateImage: vi.fn(async () => undefined),
        now: () => new Date("2026-08-31T01:00:00.000Z"), signal: new AbortController().signal,
      })).rejects.toThrow(/MEDIA_GRANT_/);
      expect(gateway.completeMediaUpload).not.toHaveBeenCalled();
    }
    expect(put).not.toHaveBeenCalled();
  });

  it("stops a stale upload after a delayed grant and never starts PUT or Complete", async () => {
    let resolveGrant!: (grant: {
      mediaId: string; uploadUrl: string; requiredHeaders: { "x-amz-checksum-sha256": string }; expiresAt: string;
    }) => void;
    const grant = new Promise<{
      mediaId: string; uploadUrl: string; requiredHeaders: { "x-amz-checksum-sha256": string }; expiresAt: string;
    }>((resolve) => { resolveGrant = resolve; });
    const gateway = {
      createMediaUpload: vi.fn(() => grant),
      completeMediaUpload: vi.fn(), getMedia: vi.fn(), getMediaDownloadGrant: vi.fn(),
    };
    const put = vi.fn();
    const controller = new AbortController();
    const pending = uploadMediaFile({
      roomId: ROOM_ID, file: new File(["abc"], "pond.png", { type: "image/png" }),
      kind: "image", altText: "池塘", caption: null, gateway,
      allowedUploadOrigins: ["https://storage.learning-orbit.test"], fetch: put,
      hash: vi.fn(async () => HASH), validateImage: vi.fn(async () => undefined),
      now: () => new Date("2026-08-31T01:00:00.000Z"), signal: controller.signal,
    });
    await vi.waitFor(() => expect(gateway.createMediaUpload).toHaveBeenCalledOnce());
    controller.abort();
    resolveGrant({
      mediaId: MEDIA_ID,
      uploadUrl: "https://storage.learning-orbit.test/put",
      requiredHeaders: { "x-amz-checksum-sha256": HASH.base64 },
      expiresAt: "2026-08-31T01:05:00.000Z",
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(put).not.toHaveBeenCalled();
    expect(gateway.completeMediaUpload).not.toHaveBeenCalled();
  });

  it("stops a stale upload after delayed PUT settlement and never calls Complete", async () => {
    let resolvePut!: (response: Response) => void;
    const put = vi.fn(() => new Promise<Response>((resolve) => { resolvePut = resolve; }));
    const gateway = {
      createMediaUpload: vi.fn(async () => ({
        mediaId: MEDIA_ID,
        uploadUrl: "https://storage.learning-orbit.test/put",
        requiredHeaders: { "x-amz-checksum-sha256": HASH.base64 },
        expiresAt: "2026-08-31T01:05:00.000Z",
      })),
      completeMediaUpload: vi.fn(), getMedia: vi.fn(), getMediaDownloadGrant: vi.fn(),
    };
    const controller = new AbortController();
    const pending = uploadMediaFile({
      roomId: ROOM_ID, file: new File(["abc"], "pond.png", { type: "image/png" }),
      kind: "image", altText: "池塘", caption: null, gateway,
      allowedUploadOrigins: ["https://storage.learning-orbit.test"], fetch: put,
      hash: vi.fn(async () => HASH), validateImage: vi.fn(async () => undefined),
      now: () => new Date("2026-08-31T01:00:00.000Z"), signal: controller.signal,
    });
    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
    controller.abort();
    resolvePut(new Response(null, { status: 200 }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(gateway.completeMediaUpload).not.toHaveBeenCalled();
  });

  it("accepts a supported recorder codec parameter but sends only its safe MIME essence", async () => {
    const gateway = {
      createMediaUpload: vi.fn(async () => ({
        mediaId: MEDIA_ID,
        uploadUrl: "https://storage.learning-orbit.test/put",
        requiredHeaders: { "x-amz-checksum-sha256": HASH.base64 },
        expiresAt: "2026-08-31T01:05:00.000Z",
      })),
      completeMediaUpload: vi.fn(async () => ({ mediaId: MEDIA_ID, state: "processing" as const, enqueued: true })),
      getMedia: vi.fn(), getMediaDownloadGrant: vi.fn(),
    };
    await uploadMediaFile({
      roomId: ROOM_ID,
      file: new File(["abc"], "recording.webm", { type: "audio/webm;codecs=opus" }),
      kind: "audio", altText: null, caption: null, gateway,
      allowedUploadOrigins: ["https://storage.learning-orbit.test"],
      fetch: vi.fn(async () => new Response(null, { status: 200 })),
      hash: vi.fn(async () => HASH),
      now: () => new Date("2026-08-31T01:00:00.000Z"),
      signal: new AbortController().signal,
    });
    expect(gateway.createMediaUpload).toHaveBeenCalledWith(ROOM_ID, expect.objectContaining({ mime: "audio/webm" }));
  });
});
