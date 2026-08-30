import { randomUUID } from "node:crypto";

import type { Pool, PoolClient, QueryResultRow } from "pg";

import { inTransaction } from "../../db/transactions.js";
import { lockRoomInTransaction, withRoomSessionLock } from "../rooms/room-lock.js";
import { systemClock, type Clock } from "../../clock.js";
import type { MediaKind, MediaState, MediaAssetRecord } from "./media-asset-record.js";
import { serializeMediaAttachment } from "./media-asset-record.js";
import { MediaError } from "./media-errors.js";
import { effectiveWriteNotAfter } from "./media-upload-expiry.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGING_KEY_PATTERN = /^rooms\/([0-9a-f-]{36})\/staging\/([0-9a-f-]{36})$/i;
const ORIGINAL_KEY_PATTERN = /^rooms\/([0-9a-f-]{36})\/original\/([0-9a-f-]{36})$/i;

export interface LockedMedia {
  readonly record: MediaAssetRecord;
  readonly grant: UploadGrantRow;
}

export interface UploadGrantRow {
  readonly grantId: string;
  readonly mediaId: string;
  readonly roomId: string;
  readonly objectKey: string;
  readonly state: "issuing" | "active" | "promoted" | "revoked" | "expired" | "closed";
  readonly correlationId: string;
  readonly reservedAt: Date;
  readonly signedAt: Date | null;
  readonly expiresAt: Date;
  readonly writeNotAfter: Date;
  readonly activatedAt: Date | null;
  readonly promotionSourceEtag: string | null;
  readonly promotionSha256: string | null;
  readonly promotionDestinationKey: string | null;
  readonly promotionCorrelationId: string | null;
  readonly promotionStartedAt: Date | null;
  readonly promotionWriteNotAfter: Date | null;
}

export interface PromotionIntent extends UploadGrantRow {
  readonly promotionDestinationKey: string;
  readonly promotionSourceEtag: string;
  readonly promotionSha256: string;
  readonly promotionCorrelationId: string;
  readonly promotionStartedAt: Date;
  readonly promotionWriteNotAfter: Date;
}

interface MediaAssetDbRow extends QueryResultRow {
  media_id: string;
  room_id: string;
  owner_actor_id: string;
  kind: MediaKind;
  state: MediaState;
  original_file_name: string;
  declared_mime: string;
  detected_mime: string | null;
  size_bytes: string;
  declared_sha256: string;
  sha256: string | null;
  alt_text: string | null;
  caption: string | null;
  object_key: string | null;
  failure_code: string | null;
  promotion_correlation_id: string | null;
  outcome_transition_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface UploadGrantDbRow extends QueryResultRow {
  grant_id: string;
  media_id: string;
  room_id: string;
  object_key: string;
  state: UploadGrantRow["state"];
  correlation_id: string;
  reserved_at: Date;
  signed_at: Date | null;
  expires_at: Date;
  write_not_after: Date;
  activated_at: Date | null;
  promotion_source_etag: string | null;
  promotion_sha256: string | null;
  promotion_destination_key: string | null;
  promotion_correlation_id: string | null;
  promotion_started_at: Date | null;
  promotion_write_not_after: Date | null;
}

interface RoomRow extends QueryResultRow {
  room_id: string;
  status: "scheduled" | "open" | "paused" | "closed";
  closes_at: Date | null;
}

function requireUuid(value: string, code = "INVALID_MEDIA_COMMAND"): string {
  if (!UUID_PATTERN.test(value)) throw new MediaError(code, 400);
  return value;
}

function requireDate(value: Date | null, code = "INVALID_MEDIA_STATE"): Date | null {
  if (value !== null && (!(value instanceof Date) || !Number.isFinite(value.getTime()))) {
    throw new MediaError(code, 500);
  }
  return value;
}

function toNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new MediaError("INVALID_MEDIA_STATE", 500);
  return parsed;
}

function toRecord(row: MediaAssetDbRow): MediaAssetRecord {
  requireUuid(row.media_id, "INVALID_MEDIA_STATE");
  requireUuid(row.room_id, "INVALID_MEDIA_STATE");
  requireUuid(row.owner_actor_id, "INVALID_MEDIA_STATE");
  requireDate(row.created_at, "INVALID_MEDIA_STATE");
  requireDate(row.updated_at, "INVALID_MEDIA_STATE");
  return Object.freeze({
    mediaId: row.media_id,
    roomId: row.room_id,
    ownerActorId: row.owner_actor_id,
    kind: row.kind,
    state: row.state,
    originalFileName: row.original_file_name,
    declaredMime: row.declared_mime,
    detectedMime: row.detected_mime,
    sizeBytes: toNumber(row.size_bytes),
    declaredSha256: row.declared_sha256,
    sha256: row.sha256,
    altText: row.alt_text,
    caption: row.caption,
    objectKey: row.object_key,
    failureCode: row.failure_code,
    promotionCorrelationId: row.promotion_correlation_id,
    outcomeTransitionId: row.outcome_transition_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toGrant(row: UploadGrantDbRow): UploadGrantRow {
  requireUuid(row.grant_id, "INVALID_MEDIA_STATE");
  requireUuid(row.media_id, "INVALID_MEDIA_STATE");
  requireUuid(row.room_id, "INVALID_MEDIA_STATE");
  requireUuid(row.correlation_id, "INVALID_MEDIA_STATE");
  [row.reserved_at, row.signed_at, row.expires_at, row.write_not_after, row.activated_at, row.promotion_started_at, row.promotion_write_not_after]
    .forEach((value) => requireDate(value, "INVALID_MEDIA_STATE"));
  return Object.freeze({
    grantId: row.grant_id,
    mediaId: row.media_id,
    roomId: row.room_id,
    objectKey: row.object_key,
    state: row.state,
    correlationId: row.correlation_id,
    reservedAt: row.reserved_at,
    signedAt: row.signed_at,
    expiresAt: row.expires_at,
    writeNotAfter: row.write_not_after,
    activatedAt: row.activated_at,
    promotionSourceEtag: row.promotion_source_etag,
    promotionSha256: row.promotion_sha256,
    promotionDestinationKey: row.promotion_destination_key,
    promotionCorrelationId: row.promotion_correlation_id,
    promotionStartedAt: row.promotion_started_at,
    promotionWriteNotAfter: row.promotion_write_not_after,
  });
}

const assetColumns = `media_id, room_id, owner_actor_id, kind, state,
  original_file_name, declared_mime, detected_mime, size_bytes,
  declared_sha256, sha256, alt_text, caption, object_key, failure_code,
  promotion_correlation_id, outcome_transition_id, created_at, updated_at`;
const grantColumns = `grant_id, media_id, room_id, object_key, state,
  correlation_id, reserved_at, signed_at, expires_at, write_not_after,
  activated_at, promotion_source_etag, promotion_sha256,
  promotion_destination_key, promotion_correlation_id, promotion_started_at,
  promotion_write_not_after`;

export interface PendingAssetInput {
  readonly mediaId: string;
  readonly grantId: string;
  readonly roomId: string;
  readonly ownerActorId: string;
  readonly kind: MediaKind;
  readonly originalFileName: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly altText: string | null;
  readonly caption: string | null;
  readonly objectKey: string;
  readonly correlationId: string;
  readonly signatureTtlMs: number;
  readonly maxUploadRequestMs: number;
  readonly maxSignerDbClockSkewMs: number;
}

export class MediaRepository {
  constructor(
    readonly pool: Pool,
    readonly clock: Clock = systemClock,
  ) {}

  async withRoomSessionLock<T>(roomId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    requireUuid(roomId);
    return withRoomSessionLock(this.pool, roomId, work);
  }

  async withRoomTransaction<T>(roomId: string, work: (client: PoolClient, room: RoomRow) => Promise<T>): Promise<T> {
    requireUuid(roomId);
    return inTransaction(this.pool, async (client) => {
      await lockRoomInTransaction(client, roomId);
      const result = await client.query<RoomRow>(
        "SELECT room_id, status, closes_at FROM classroom_room WHERE room_id = $1 FOR UPDATE",
        [roomId],
      );
      const room = result.rows[0];
      if (!room) throw new MediaError("MEDIA_NOT_FOUND", 404);
      return work(client, room);
    });
  }

  async insertPendingAssetAndIssuingGrant(
    client: PoolClient,
    input: PendingAssetInput,
  ): Promise<{ asset: MediaAssetRecord; grant: UploadGrantRow }> {
    requireUuid(input.mediaId, "INVALID_MEDIA_COMMAND");
    requireUuid(input.grantId, "INVALID_MEDIA_COMMAND");
    requireUuid(input.roomId, "INVALID_MEDIA_COMMAND");
    requireUuid(input.ownerActorId, "INVALID_MEDIA_COMMAND");
    requireUuid(input.correlationId, "INVALID_MEDIA_COMMAND");
    if (!STAGING_KEY_PATTERN.test(input.objectKey) || !input.objectKey.includes(input.roomId) || !input.objectKey.includes(input.grantId)) {
      throw new MediaError("INVALID_MEDIA_COMMAND", 400);
    }
    const assetResult = await client.query<MediaAssetDbRow>(
      `INSERT INTO media_asset(
         media_id, room_id, owner_actor_id, kind, state,
         original_file_name, declared_mime, size_bytes, declared_sha256,
         alt_text, caption
       ) VALUES($1,$2,$3,$4,'upload_pending',$5,$6,$7,$8,$9,$10)
       RETURNING ${assetColumns}`,
      [input.mediaId, input.roomId, input.ownerActorId, input.kind, input.originalFileName,
        input.mime, input.sizeBytes, input.sha256, input.altText, input.caption],
    );
    const asset = assetResult.rows[0];
    if (!asset) throw new MediaError("INVALID_MEDIA_STATE", 500);

    const grantResult = await client.query<UploadGrantDbRow>(
      `INSERT INTO media_upload_grant(
         grant_id, media_id, room_id, object_key, state, correlation_id,
         reserved_at, expires_at, write_not_after
       ) VALUES(
         $1,$2,$3,$4,'issuing',$5,transaction_timestamp(),
         transaction_timestamp() + ($6::bigint * interval '1 millisecond'),
         transaction_timestamp() + (($6::bigint + $7::bigint + $8::bigint) * interval '1 millisecond')
       )
       RETURNING ${grantColumns}`,
      [input.grantId, input.mediaId, input.roomId, input.objectKey, input.correlationId,
        input.signatureTtlMs, input.maxUploadRequestMs, input.maxSignerDbClockSkewMs],
    );
    const grant = grantResult.rows[0];
    if (!grant) throw new MediaError("INVALID_MEDIA_STATE", 500);
    return { asset: toRecord(asset), grant: toGrant(grant) };
  }

  async activateGrant(
    client: PoolClient,
    grantId: string,
    signed: { signedAt: Date; expiresAt: Date },
    options: { signatureTtlMs: number; maxUploadRequestMs: number; maxSignerDbClockSkewMs: number },
  ): Promise<UploadGrantRow> {
    requireUuid(grantId, "INVALID_MEDIA_COMMAND");
    if (!(signed.signedAt instanceof Date) || !(signed.expiresAt instanceof Date)) throw new MediaError("STORAGE_SIGNED_WINDOW_INVALID", 502);
    const result = await client.query<UploadGrantDbRow>(
      `UPDATE media_upload_grant
       SET state = 'active', signed_at = $2, expires_at = $3,
           activated_at = transaction_timestamp(),
           write_not_after = GREATEST(
             $3::timestamptz + ($4::bigint * interval '1 millisecond') + ($5::bigint * interval '1 millisecond'),
             transaction_timestamp() + (($6::bigint + $4::bigint + $5::bigint) * interval '1 millisecond')
           )
       WHERE grant_id = $1 AND state = 'issuing'
       RETURNING ${grantColumns}`,
      [grantId, signed.signedAt, signed.expiresAt, options.maxUploadRequestMs,
        options.maxSignerDbClockSkewMs, options.signatureTtlMs],
    );
    const row = result.rows[0];
    if (!row) throw new MediaError("MEDIA_UPLOAD_NOT_FOUND", 404);
    return toGrant(row);
  }

  async revokeGrant(client: PoolClient, grantId: string, reason: string): Promise<void> {
    requireUuid(grantId, "INVALID_MEDIA_COMMAND");
    await client.query(
      `UPDATE media_upload_grant
       SET state = CASE WHEN state IN ('issuing','active') THEN 'revoked' ELSE state END,
           revoked_at = CASE WHEN state IN ('issuing','active') THEN transaction_timestamp() ELSE revoked_at END
       WHERE grant_id = $1`,
      [grantId],
    );
    void reason;
  }

  async lockOwnedMediaAndGrant(
    client: PoolClient,
    mediaId: string,
    roomId: string,
    ownerActorId: string,
  ): Promise<LockedMedia> {
    requireUuid(mediaId, "INVALID_MEDIA_COMMAND");
    requireUuid(roomId, "INVALID_MEDIA_COMMAND");
    requireUuid(ownerActorId, "INVALID_MEDIA_COMMAND");
    const assetResult = await client.query<MediaAssetDbRow>(
      `SELECT ${assetColumns} FROM media_asset
       WHERE media_id = $1 AND room_id = $2 AND owner_actor_id = $3
       FOR UPDATE`,
      [mediaId, roomId, ownerActorId],
    );
    const asset = assetResult.rows[0];
    if (!asset) throw new MediaError("MEDIA_NOT_FOUND", 404);
    const grantResult = await client.query<UploadGrantDbRow>(
      `SELECT ${grantColumns} FROM media_upload_grant
       WHERE media_id = $1 AND room_id = $2 FOR UPDATE`,
      [mediaId, roomId],
    );
    const grant = grantResult.rows[0];
    if (!grant) throw new MediaError("MEDIA_NOT_FOUND", 404);
    return { record: toRecord(asset), grant: toGrant(grant) };
  }

  async getMedia(mediaId: string, roomId?: string): Promise<MediaAssetRecord | null> {
    requireUuid(mediaId, "INVALID_MEDIA_COMMAND");
    const values: unknown[] = [mediaId];
    const roomClause = roomId === undefined ? "" : " AND room_id = $2";
    if (roomId !== undefined) {
      requireUuid(roomId, "INVALID_MEDIA_COMMAND");
      values.push(roomId);
    }
    const result = await this.pool.query<MediaAssetDbRow>(
      `SELECT ${assetColumns} FROM media_asset WHERE media_id = $1${roomClause}`,
      values,
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async getPublicMedia(mediaId: string, roomId: string) {
    const record = await this.getMedia(mediaId, roomId);
    return record ? serializeMediaAttachment(record) : null;
  }

  async getGrantForMedia(mediaId: string, roomId: string): Promise<UploadGrantRow | null> {
    requireUuid(mediaId, "INVALID_MEDIA_COMMAND");
    requireUuid(roomId, "INVALID_MEDIA_COMMAND");
    const result = await this.pool.query<UploadGrantDbRow>(
      `SELECT ${grantColumns} FROM media_upload_grant WHERE media_id = $1 AND room_id = $2`,
      [mediaId, roomId],
    );
    return result.rows[0] ? toGrant(result.rows[0]) : null;
  }

  async lockGrantForMedia(client: PoolClient, mediaId: string, roomId: string): Promise<UploadGrantRow | null> {
    requireUuid(mediaId, "INVALID_MEDIA_COMMAND");
    requireUuid(roomId, "INVALID_MEDIA_COMMAND");
    const result = await client.query<UploadGrantDbRow>(
      `SELECT ${grantColumns} FROM media_upload_grant
       WHERE media_id = $1 AND room_id = $2 FOR UPDATE`,
      [mediaId, roomId],
    );
    return result.rows[0] ? toGrant(result.rows[0]) : null;
  }

  async recordPromotionIntent(
    client: PoolClient,
    grant: UploadGrantRow,
    source: { etag: string; sha256: string },
    destinationKey: string,
    correlationId: string,
    options: { hardTotalMs: number; settlementMs: number },
  ): Promise<PromotionIntent> {
    requireUuid(correlationId, "INVALID_MEDIA_COMMAND");
    if (!grant.objectKey || !STAGING_KEY_PATTERN.test(grant.objectKey)) throw new MediaError("INVALID_MEDIA_STATE", 500);
    if (!ORIGINAL_KEY_PATTERN.test(destinationKey)) throw new MediaError("INVALID_MEDIA_COMMAND", 400);
    if (!/^[a-f0-9]{64}$/.test(source.sha256) || !source.etag) throw new MediaError("OBJECT_IDENTITY_CHANGED", 409);
    const result = await client.query<UploadGrantDbRow>(
      `UPDATE media_upload_grant
       SET promotion_source_etag = $2,
           promotion_sha256 = $3,
           promotion_destination_key = $4,
           promotion_correlation_id = COALESCE(promotion_correlation_id, $5::uuid),
           promotion_started_at = COALESCE(promotion_started_at, transaction_timestamp()),
           promotion_write_not_after = GREATEST(
             COALESCE(promotion_write_not_after, transaction_timestamp() + ($6::bigint * interval '1 millisecond')),
             transaction_timestamp() + ($7::bigint * interval '1 millisecond')
           )
       WHERE grant_id = $1
       RETURNING ${grantColumns}`,
      [grant.grantId, source.etag, source.sha256, destinationKey, correlationId,
        options.hardTotalMs + options.settlementMs, options.hardTotalMs + options.settlementMs],
    );
    const row = result.rows[0];
    if (!row) throw new MediaError("MEDIA_UPLOAD_NOT_FOUND", 404);
    const next = toGrant(row);
    if (!next.promotionSourceEtag || !next.promotionSha256 || !next.promotionDestinationKey || !next.promotionCorrelationId || !next.promotionStartedAt || !next.promotionWriteNotAfter) {
      throw new MediaError("INVALID_MEDIA_STATE", 500);
    }
    const jobResult = await client.query(
      `INSERT INTO worker_job(
         job_type, room_id, source_event_id, dedupe_key,
         correlation_id, payload, run_after
       ) VALUES('media.reconcile-upload.v1',$1,NULL,$2,$3,$4,transaction_timestamp())
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [next.roomId, `media.reconcile-upload.v1:${next.mediaId}`, next.promotionCorrelationId, { mediaId: next.mediaId }],
    );
    void jobResult;
    return Object.freeze({
      ...next,
      promotionSourceEtag: next.promotionSourceEtag,
      promotionSha256: next.promotionSha256,
      promotionDestinationKey: next.promotionDestinationKey,
      promotionCorrelationId: next.promotionCorrelationId,
      promotionStartedAt: next.promotionStartedAt,
      promotionWriteNotAfter: next.promotionWriteNotAfter,
    });
  }

  async extendPromotionWriteFenceFromDbTime(
    client: PoolClient,
    grantId: string,
    options: { hardTotalMs: number; settlementMs: number },
  ): Promise<UploadGrantRow> {
    requireUuid(grantId, "INVALID_MEDIA_COMMAND");
    const duration = options.hardTotalMs + options.settlementMs;
    if (!Number.isSafeInteger(duration) || duration < 0) throw new MediaError("INVALID_MEDIA_COMMAND", 400);
    const result = await client.query<UploadGrantDbRow>(
      `UPDATE media_upload_grant
       SET promotion_write_not_after = GREATEST(
         COALESCE(promotion_write_not_after, transaction_timestamp()),
         transaction_timestamp() + ($2::bigint * interval '1 millisecond')
       )
       WHERE grant_id = $1 RETURNING ${grantColumns}`,
      [grantId, duration],
    );
    const row = result.rows[0];
    if (!row) throw new MediaError("MEDIA_UPLOAD_NOT_FOUND", 404);
    return toGrant(row);
  }

  async commitPromotionAndEnqueue(
    client: PoolClient,
    input: {
      readonly mediaId: string;
      readonly roomId: string;
      readonly ownerActorId: string;
      readonly immutableKey: string;
      readonly sha256: string;
      readonly detectedMime: string;
      readonly correlationId: string;
    },
  ): Promise<{ mediaId: string; state: "uploaded"; enqueued: boolean; correlationId: string }> {
    requireUuid(input.mediaId, "INVALID_MEDIA_COMMAND");
    requireUuid(input.roomId, "INVALID_MEDIA_COMMAND");
    requireUuid(input.ownerActorId, "INVALID_MEDIA_COMMAND");
    requireUuid(input.correlationId, "INVALID_MEDIA_COMMAND");
    if (!ORIGINAL_KEY_PATTERN.test(input.immutableKey) || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new MediaError("OBJECT_PROMOTION_MISMATCH", 409);
    const locked = await this.lockOwnedMediaAndGrant(client, input.mediaId, input.roomId, input.ownerActorId);
    if (locked.grant.promotionCorrelationId && locked.grant.promotionCorrelationId !== input.correlationId) {
      throw new MediaError("PROMOTION_IDENTITY_MISMATCH", 409);
    }
    if (locked.record.state !== "upload_pending") {
      if (locked.record.objectKey !== input.immutableKey || locked.record.sha256 !== input.sha256) throw new MediaError("OBJECT_IDENTITY_CHANGED", 409);
      return { mediaId: locked.record.mediaId, state: "uploaded", enqueued: false, correlationId: locked.record.promotionCorrelationId || input.correlationId };
    }
    await client.query(
      `UPDATE media_asset
       SET state = 'uploaded', object_key = $4, sha256 = $5,
           detected_mime = $6, promotion_correlation_id = $7,
           updated_at = transaction_timestamp()
       WHERE media_id = $1 AND room_id = $2 AND owner_actor_id = $3`,
      [input.mediaId, input.roomId, input.ownerActorId, input.immutableKey, input.sha256, input.detectedMime, input.correlationId],
    );
    await client.query(
      `UPDATE media_upload_grant
       SET state = 'promoted'
       WHERE media_id = $1 AND room_id = $2`,
      [input.mediaId, input.roomId],
    );
    const job = await client.query(
      `INSERT INTO worker_job(
         job_type, room_id, source_event_id, dedupe_key,
         correlation_id, payload, run_after
       ) VALUES('media.process.v1',$1,NULL,$2,$3,$4,transaction_timestamp())
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING job_id`,
      [input.roomId, `media.process.v1:${input.mediaId}`, input.correlationId, { mediaId: input.mediaId }],
    );
    return {
      mediaId: input.mediaId,
      state: "uploaded",
      enqueued: job.rowCount === 1,
      correlationId: input.correlationId,
    };
  }

  async markGrantClosed(client: PoolClient, grantId: string): Promise<void> {
    requireUuid(grantId, "INVALID_MEDIA_COMMAND");
    await client.query(
      `UPDATE media_upload_grant SET state = 'closed', closed_at = transaction_timestamp()
       WHERE grant_id = $1 AND state IN ('revoked','expired','promoted')`,
      [grantId],
    );
  }

  async effectiveGrantFence(mediaId: string, roomId: string): Promise<Date | null> {
    const grant = await this.getGrantForMedia(mediaId, roomId);
    if (!grant) return null;
    return effectiveWriteNotAfter(grant);
  }
}
