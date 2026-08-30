import { maxDate } from "./media-store.js";
import { MediaError } from "./media-errors.js";

export interface UploadGrantTimes {
  readonly writeNotAfter: Date;
  readonly expiresAt: Date;
  readonly activatedAt?: Date | null;
  readonly promotionWriteNotAfter?: Date | null;
}

export interface SignedUploadTimes {
  readonly signedAt: Date;
  readonly expiresAt: Date;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/** The one shared fence calculation used by finalize, reconcile and janitor. */
export function effectiveWriteNotAfter(grant: UploadGrantTimes): Date {
  if (!validDate(grant.writeNotAfter)) throw new MediaError("INVALID_MEDIA_STATE", 500);
  const promotion = grant.promotionWriteNotAfter;
  if (promotion !== null && promotion !== undefined && !validDate(promotion)) {
    throw new MediaError("INVALID_MEDIA_STATE", 500);
  }
  return maxDate(grant.writeNotAfter, ...(promotion ? [promotion] : []));
}

export function assertExactSignedWindow(
  signed: SignedUploadTimes,
  ttlSeconds: number,
  reservedAt: Date,
  maxPresignMs: number,
  maxSignerDbClockSkewMs: number,
): void {
  if (
    !validDate(signed.signedAt)
    || !validDate(signed.expiresAt)
    || !validDate(reservedAt)
    || !Number.isSafeInteger(ttlSeconds)
    || ttlSeconds <= 0
    || !Number.isFinite(maxPresignMs)
    || maxPresignMs < 0
    || !Number.isFinite(maxSignerDbClockSkewMs)
    || maxSignerDbClockSkewMs < 0
  ) throw new MediaError("STORAGE_SIGNED_WINDOW_INVALID", 502);
  if (signed.expiresAt.getTime() - signed.signedAt.getTime() !== ttlSeconds * 1_000) {
    throw new MediaError("STORAGE_SIGNED_WINDOW_INVALID", 502);
  }
  const lower = reservedAt.getTime() - maxSignerDbClockSkewMs;
  const upper = reservedAt.getTime() + maxPresignMs + maxSignerDbClockSkewMs;
  if (signed.signedAt.getTime() < lower || signed.signedAt.getTime() > upper) {
    throw new MediaError("STORAGE_SIGNED_WINDOW_INVALID", 502);
  }
}

export function deriveUploadWriteNotAfter(input: {
  readonly signedExpiresAt: Date;
  readonly activatedAt: Date;
  readonly uploadDurationMs: number;
  readonly signerDbClockSkewMs: number;
  readonly signatureTtlMs: number;
}): Date {
  if (!validDate(input.signedExpiresAt) || !validDate(input.activatedAt)) {
    throw new MediaError("INVALID_MEDIA_STATE", 500);
  }
  const values = [
    input.signedExpiresAt.getTime() + input.uploadDurationMs + input.signerDbClockSkewMs,
    input.activatedAt.getTime() + input.signatureTtlMs + input.uploadDurationMs + input.signerDbClockSkewMs,
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new MediaError("INVALID_MEDIA_STATE", 500);
  }
  return new Date(Math.max(...values));
}

export function uploadExpiryDecision(
  grant: UploadGrantTimes,
  now: Date,
): { state: "blocked" | "eligible"; notBefore: Date } {
  if (!validDate(now)) throw new MediaError("INVALID_MEDIA_STATE", 500);
  const notBefore = effectiveWriteNotAfter(grant);
  return now.getTime() < notBefore.getTime()
    ? { state: "blocked", notBefore }
    : { state: "eligible", notBefore };
}
