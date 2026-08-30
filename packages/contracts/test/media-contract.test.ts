import { describe, expect, it } from "vitest";

import {
  mediaAttachmentContract,
  mediaCommandContract,
  mediaStatusContract,
  realtimeContract,
  routes,
} from "../src/index.js";

const MEDIA_ID = "00000000-0000-4000-8000-000000000701";
const ROOM_ID = "00000000-0000-4000-8000-000000000010";

describe("media contracts", () => {
  it("parses a closed public attachment view without internal identity", () => {
    const view = mediaAttachmentContract.parse({
      mediaId: MEDIA_ID,
      kind: "image",
      state: "ready",
      detectedMime: "image/png",
      sizeBytes: 1200,
      altText: "池塘草圖",
      caption: "觀察",
      failureCode: null,
      createdAt: "2026-08-28T09:12:00Z",
      updatedAt: "2026-08-28T09:12:00Z",
    });
    expect(view).toMatchObject({ mediaId: MEDIA_ID, state: "ready" });
    expect(view).not.toHaveProperty("roomId");
    expect(view).not.toHaveProperty("ownerActorId");
    expect(view).not.toHaveProperty("objectKey");
  });

  it("rejects whitespace alt text and unknown public fields", () => {
    expect(() => mediaAttachmentContract.parse({
      mediaId: MEDIA_ID,
      kind: "image",
      state: "ready",
      detectedMime: "image/png",
      sizeBytes: 1200,
      altText: "   ",
      caption: null,
      failureCode: null,
      createdAt: "2026-08-28T09:12:00Z",
      updatedAt: "2026-08-28T09:12:00Z",
    })).toThrow("INVALID_MEDIA_ATTACHMENT_VIEW");
    expect(() => mediaAttachmentContract.parse({
      mediaId: MEDIA_ID,
      kind: "audio",
      state: "ready",
      detectedMime: "audio/webm",
      sizeBytes: 1200,
      altText: null,
      caption: null,
      failureCode: null,
      createdAt: "2026-08-28T09:12:00Z",
      updatedAt: "2026-08-28T09:12:00Z",
      signedUrl: "https://storage.invalid/private",
    })).toThrow("INVALID_MEDIA_ATTACHMENT_VIEW");
  });

  it("parses status frames and exposes only canonical media routes", () => {
    const frame = realtimeContract.parseRealtimeFrame({
      type: "media_status",
      mediaId: MEDIA_ID,
      state: "ready",
      failureCode: null,
      updatedAt: "2026-08-28T09:12:00Z",
    });
    expect(frame).toEqual({
      type: "media_status",
      mediaId: MEDIA_ID,
      state: "ready",
      failureCode: null,
      updatedAt: "2026-08-28T09:12:00Z",
    });
    expect(routes.media.upload(ROOM_ID)).toBe(`/v1/rooms/${ROOM_ID}/media/uploads`);
    expect(routes.media.get(ROOM_ID, MEDIA_ID)).toBe(`/v1/rooms/${ROOM_ID}/media/${MEDIA_ID}`);
    expect(routes.media.complete(ROOM_ID, MEDIA_ID)).toBe(`/v1/rooms/${ROOM_ID}/media/${MEDIA_ID}/complete`);
    expect(routes.media.download(ROOM_ID, MEDIA_ID)).toBe(`/v1/rooms/${ROOM_ID}/media/${MEDIA_ID}/download`);
  });

  it("parses upload command definitions without accepting client correlation", () => {
    const request = mediaCommandContract.parseCreateUpload({
      kind: "image",
      originalFileName: "pond.png",
      mime: "image/png",
      sizeBytes: 1200,
      sha256: "a".repeat(64),
      altText: "池塘草圖",
      caption: "觀察",
    });
    expect(request.kind).toBe("image");
    expect(() => mediaCommandContract.parseCreateUpload({ ...request, correlationId: MEDIA_ID })).toThrow("INVALID_MEDIA_COMMAND");
  });
});
