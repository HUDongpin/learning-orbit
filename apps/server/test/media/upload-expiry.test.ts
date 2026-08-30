import { describe, expect, it } from "vitest";

import {
  assertExactSignedWindow,
  deriveUploadWriteNotAfter,
  effectiveWriteNotAfter,
  uploadExpiryDecision,
} from "../../src/modules/media/media-upload-expiry.js";

const base = new Date("2026-08-30T08:00:00.000Z");

describe("media upload expiry fences", () => {
  it("uses the later promotion fence and blocks one millisecond early", () => {
    const grant = {
      writeNotAfter: new Date(base.getTime() + 300_000),
      expiresAt: new Date(base.getTime() + 300_000),
      promotionWriteNotAfter: new Date(base.getTime() + 420_000),
    };
    const fence = effectiveWriteNotAfter(grant);
    expect(fence.toISOString()).toBe("2026-08-30T08:07:00.000Z");
    expect(uploadExpiryDecision(grant, new Date(fence.getTime() - 1)).state).toBe("blocked");
    expect(uploadExpiryDecision(grant, fence).state).toBe("eligible");
  });

  it("derives a conservative write bound from both signer and DB timelines", () => {
    const fence = deriveUploadWriteNotAfter({
      signedExpiresAt: new Date(base.getTime() + 300_000),
      activatedAt: base,
      uploadDurationMs: 120_000,
      signerDbClockSkewMs: 5_000,
      signatureTtlMs: 300_000,
    });
    expect(fence.toISOString()).toBe("2026-08-30T08:07:05.000Z");
  });

  it("requires an exact five-minute signed window inside the reservation bound", () => {
    const signedAt = new Date(base.getTime() + 1_000);
    expect(() => assertExactSignedWindow(
      { signedAt, expiresAt: new Date(signedAt.getTime() + 300_000) },
      300,
      base,
      5_000,
      5_000,
    )).not.toThrow();
    expect(() => assertExactSignedWindow(
      { signedAt, expiresAt: new Date(signedAt.getTime() + 299_999) },
      300,
      base,
      5_000,
      5_000,
    )).toThrow("STORAGE_SIGNED_WINDOW_INVALID");
  });
});
