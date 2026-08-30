import {
  mediaAttachmentContract,
  type MediaAttachmentView,
} from "@learning-orbit/contracts";

export type MediaKind = "image" | "audio";
export type MediaState =
  | "upload_pending"
  | "uploaded"
  | "processing"
  | "ready"
  | "quarantined"
  | "failed"
  | "deleted";

export interface MediaAssetRecord {
  readonly mediaId: string;
  readonly roomId: string;
  readonly ownerActorId: string;
  readonly kind: MediaKind;
  readonly state: MediaState;
  readonly originalFileName: string;
  readonly declaredMime: string;
  readonly detectedMime: string | null;
  readonly sizeBytes: number;
  readonly declaredSha256: string;
  readonly sha256: string | null;
  readonly altText: string | null;
  readonly caption: string | null;
  readonly objectKey: string | null;
  readonly failureCode: string | null;
  readonly promotionCorrelationId: string | null;
  readonly outcomeTransitionId: string | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

function iso(value: Date | string): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("INVALID_MEDIA_RECORD");
    return value.toISOString();
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("INVALID_MEDIA_RECORD");
  return parsed.toISOString();
}

/**
 * Build the only public media representation. Internal room/owner/storage
 * identity is deliberately copied nowhere in this whitelist serializer.
 */
export function serializeMediaAttachment(record: MediaAssetRecord): MediaAttachmentView {
  const view = {
    mediaId: record.mediaId,
    kind: record.kind,
    state: record.state,
    detectedMime: record.detectedMime,
    sizeBytes: record.sizeBytes,
    altText: record.altText,
    caption: record.caption,
    failureCode: record.failureCode,
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
  return mediaAttachmentContract.parse(view);
}

export function internalMediaRecord(value: MediaAssetRecord): MediaAssetRecord {
  return Object.freeze({ ...value });
}
