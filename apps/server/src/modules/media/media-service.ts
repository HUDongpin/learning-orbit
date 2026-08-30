import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import {
  mediaAttachmentContract,
  mediaCommandContract,
  type AuthSession,
  type CompleteMediaUploadResponse,
  type MediaAttachmentView,
  type MediaDownloadGrant,
  type MediaUploadGrant,
} from "@learning-orbit/contracts";
import { inTransaction } from "../../db/transactions.js";
import { lockRoomInTransaction } from "../rooms/room-lock.js";
import type { Clock } from "../../clock.js";
import { systemClock } from "../../clock.js";
import {
  assertExactSignedWindow,
  deriveUploadWriteNotAfter,
  effectiveWriteNotAfter,
  uploadExpiryDecision,
} from "./media-upload-expiry.js";
import { MediaError } from "./media-errors.js";
import type { MediaKind, MediaState, MediaAssetRecord } from "./media-asset-record.js";
import { MediaRepository, type LockedMedia, type UploadGrantRow } from "./media-repository.js";
import type { MediaStore, StoreCallControl } from "./media-store.js";
import { hexSha256ToBase64 } from "./media-store.js";
import type { RoomWriteGate } from "./room-write-gate.js";
import { DatabaseRoomWriteGate } from "./room-write-gate.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const SIGNATURE_TTL_MS = 300_000;
const DEFAULT_MAX_UPLOAD_MS = 120_000;
const DEFAULT_MAX_PRESIGN_MS = 5_000;
const DEFAULT_MAX_SIGNER_SKEW_MS = 5_000;
const DEFAULT_BROWSER_ORIGIN = "http://127.0.0.1:59000";

export interface MediaRoomAuthorizer {
  requireActiveStudent(sessionId: string, roomId: string): Promise<{ actorId: string; roomId: string }>;
  requireRoomMember(sessionId: string, roomId: string): Promise<{ actorId: string; roomId: string }>;
}

export interface UploadRequest {
  readonly sessionId?: string;
  readonly principal?: AuthSession;
  readonly roomId: string;
  readonly kind: MediaKind;
  readonly originalFileName: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly altText: string | null;
  readonly caption: string | null;
  readonly correlationId: string;
}

export interface FinalizeInput {
  readonly sessionId?: string;
  readonly principal?: AuthSession;
  readonly roomId: string;
  readonly mediaId: string;
  readonly correlationId: string;
}

export interface MediaServiceConfig {
  readonly storageBrowserOrigins: readonly string[];
  readonly maxPresignMs: number;
  readonly maxUploadRequestMs: number;
  readonly maxSignerDbClockSkewMs: number;
  readonly maxPostAbortSettlementMs: number;
  readonly storeHeadTimeoutMs: number;
  readonly storeCopyTimeoutMs: number;
  readonly storeDownloadTtlSeconds: number;
}

const defaultConfig: MediaServiceConfig = Object.freeze({
  storageBrowserOrigins: [DEFAULT_BROWSER_ORIGIN],
  maxPresignMs: DEFAULT_MAX_PRESIGN_MS,
  maxUploadRequestMs: DEFAULT_MAX_UPLOAD_MS,
  maxSignerDbClockSkewMs: DEFAULT_MAX_SIGNER_SKEW_MS,
  maxPostAbortSettlementMs: 5_000,
  storeHeadTimeoutMs: 10_000,
  storeCopyTimeoutMs: 15_000,
  storeDownloadTtlSeconds: 60,
});

export interface MediaDeps {
  readonly pool: import("pg").Pool;
  readonly store: MediaStore;
  readonly repo?: MediaRepository;
  readonly rooms?: MediaRoomAuthorizer;
  readonly clock?: Clock;
  readonly config?: Partial<MediaServiceConfig>;
  readonly ids?: Readonly<{ uuid(): string }>;
  readonly writeGate?: RoomWriteGate;
}

function resolvedConfig(deps: MediaDeps): MediaServiceConfig {
  return Object.freeze({ ...defaultConfig, ...(deps.config ?? {}) });
}

function resolvedRepo(deps: MediaDeps): MediaRepository {
  return deps.repo ?? new MediaRepository(deps.pool, deps.clock ?? systemClock);
}

function id(deps: MediaDeps): string {
  const value = deps.ids?.uuid() ?? randomUUID();
  if (!UUID.test(value)) throw new MediaError("INVALID_MEDIA_COMMAND", 400);
  return value;
}

function now(clock: Clock): Date {
  const value = clock.now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new MediaError("INVALID_MEDIA_STATE", 500);
  return new Date(value);
}

function control(clock: Clock, signal: AbortSignal, timeoutMs: number): StoreCallControl {
  const startedAt = now(clock);
  const deadline = new Date(startedAt.getTime() + timeoutMs);
  return { signal, deadline, now: () => now(clock) };
}

function makeControl(clock: Clock, timeoutMs: number): StoreCallControl {
  return control(clock, new AbortController().signal, timeoutMs);
}

async function transaction<T>(client: PoolClient, work: () => Promise<T>): Promise<T> {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
    throw error;
  }
}

async function requireStudent(deps: MediaDeps, input: { sessionId?: string; principal?: AuthSession; roomId: string }) {
  if (!UUID.test(input.roomId)) throw new MediaError("MEDIA_NOT_FOUND", 404);
  // When a session id is available it is the authoritative credential.  The
  // principal object came from an earlier request preflight and may become
  // stale; re-check the active auth_session and membership in this query so a
  // revoke racing an upload/finalize/download cannot be bypassed.
  if (input.sessionId) {
    if (!UUID.test(input.sessionId)) throw new MediaError("MEDIA_NOT_FOUND", 404);
    const active = await deps.pool.query<{ actor_id: string; room_member_id: string }>(
      `SELECT m.actor_id, m.room_member_id
       FROM auth_session s
       JOIN room_member m ON m.room_member_id = s.room_member_id
       WHERE s.session_id = $1
         AND s.principal_kind = 'student'
         AND s.revoked_at IS NULL
         AND s.expires_at > transaction_timestamp()
         AND m.room_id = $2`,
      [input.sessionId, input.roomId],
    );
    const row = active.rows[0];
    if (!row) throw new MediaError("MEDIA_NOT_FOUND", 404);
    if (input.principal
      && (input.principal.role !== "student"
        || input.principal.roomId !== input.roomId
        || input.principal.roomMemberId !== row.room_member_id
        || input.principal.actorId !== row.actor_id)) {
      throw new MediaError("MEDIA_NOT_FOUND", 404);
    }
    return { actorId: row.actor_id, roomId: input.roomId };
  }
  if (input.principal?.role === "student") {
    if (input.principal.roomId !== input.roomId || !UUID.test(input.principal.actorId)) throw new MediaError("MEDIA_NOT_FOUND", 404);
    const membership = await deps.pool.query<{ actor_id: string }>(
      `SELECT actor_id FROM room_member
       WHERE room_id = $1 AND room_member_id = $2 AND actor_id = $3`,
      [input.roomId, input.principal.roomMemberId, input.principal.actorId],
    );
    if (membership.rowCount !== 1) throw new MediaError("MEDIA_NOT_FOUND", 404);
    return { actorId: input.principal.actorId, roomId: input.roomId };
  }
  throw new MediaError("AUTH_REQUIRED", 401);
}

/** Read-only media surfaces are available to the authenticated teacher and
 * room students; writes remain student-owned and continue through
 * ``requireStudent``.  The session row is re-read so a revoked cookie cannot
 * keep a stale principal alive during a media lookup/download. */
async function requireRoomMember(deps: MediaDeps, input: { sessionId?: string; principal?: AuthSession; roomId: string }) {
  if (!UUID.test(input.roomId)) throw new MediaError("MEDIA_NOT_FOUND", 404);
  if (input.sessionId) {
    if (!UUID.test(input.sessionId)) throw new MediaError("MEDIA_NOT_FOUND", 404);
    const active = await deps.pool.query<{
      principal_kind: "teacher" | "student";
      teacher_id: string | null;
      room_member_id: string | null;
      actor_id: string | null;
    }>(
      `SELECT s.principal_kind,s.teacher_id,s.room_member_id,m.actor_id
         FROM auth_session s
         LEFT JOIN room_member m ON m.room_member_id=s.room_member_id
        WHERE s.session_id=$1
          AND s.revoked_at IS NULL
          AND s.expires_at > transaction_timestamp()
          AND ((s.principal_kind='teacher' AND s.teacher_id IN (SELECT teacher_id FROM classroom_room WHERE room_id=$2))
            OR (s.principal_kind='student' AND m.room_id=$2))`,
      [input.sessionId, input.roomId],
    );
    const row = active.rows[0];
    if (!row) throw new MediaError("MEDIA_NOT_FOUND", 404);
    if (input.principal?.role === "teacher"
      && (row.principal_kind !== "teacher" || row.teacher_id !== input.principal.teacherId)) {
      throw new MediaError("MEDIA_NOT_FOUND", 404);
    }
    if (input.principal?.role === "student"
      && (row.principal_kind !== "student"
        || row.room_member_id !== input.principal.roomMemberId
        || row.actor_id !== input.principal.actorId)) {
      throw new MediaError("MEDIA_NOT_FOUND", 404);
    }
    return { actorId: row.actor_id ?? row.teacher_id ?? "", roomId: input.roomId };
  }
  if (input.principal?.role === "student") return requireStudent(deps, input);
  if (input.principal?.role === "teacher") {
    const room = await deps.pool.query(
      "SELECT 1 FROM classroom_room WHERE room_id=$1 AND teacher_id=$2",
      [input.roomId, input.principal.teacherId],
    );
    if (room.rowCount !== 1) throw new MediaError("MEDIA_NOT_FOUND", 404);
    return { actorId: input.principal.teacherId, roomId: input.roomId };
  }
  throw new MediaError("AUTH_REQUIRED", 401);
}

function assertCapabilities(store: MediaStore, config: MediaServiceConfig): void {
  const c = store.capabilities;
  if (!c
    || c.exactKeyHeadIsStronglyConsistent !== true
    || c.strongChecksumHead !== true
    || c.conditionalPromotion !== true
    || c.writeOnceDestination !== true
    || c.maxUploadRequestMs !== config.maxUploadRequestMs
    || !Number.isFinite(c.maxSignerDbClockSkewMs)
    || c.maxSignerDbClockSkewMs < 0
    || !Number.isFinite(c.maxPostAbortSettlementMs)
    || c.maxPostAbortSettlementMs < 0) {
    throw new MediaError("STORAGE_UPLOAD_FENCE_UNPROVEN", 503);
  }
}

function normalizedUploadBody(value: unknown): {
  kind: MediaKind;
  originalFileName: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  altText: string | null;
  caption: string | null;
} {
  const source = value as Partial<Record<"kind" | "originalFileName" | "mime" | "sizeBytes" | "sha256" | "altText" | "caption", unknown>>;
  if (source.kind === "image" && (typeof source.altText !== "string" || source.altText.trim().length === 0)) {
    throw new MediaError("ALT_REQUIRED", 422);
  }
  const parsed = mediaCommandContract.parseCreateUpload({
    kind: source.kind,
    originalFileName: source.originalFileName,
    mime: source.mime,
    sizeBytes: source.sizeBytes,
    sha256: source.sha256,
    altText: source.altText,
    caption: source.caption,
  });
  const kind = parsed.kind;
  const originalFileName = parsed.originalFileName;
  const mime = parsed.mime;
  const sizeBytes = parsed.sizeBytes;
  const sha256 = parsed.sha256;
  const altText = parsed.altText;
  const caption = parsed.caption;
  if (kind !== "image" && kind !== "audio") throw new MediaError("INVALID_MEDIA_COMMAND", 400);
  if (typeof originalFileName !== "string" || typeof mime !== "string" || typeof sha256 !== "string" || typeof sizeBytes !== "number") throw new MediaError("INVALID_MEDIA_COMMAND", 400);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > (kind === "image" ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES)) throw new MediaError("SIZE_OUT_OF_RANGE", 422);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new MediaError("INVALID_MEDIA_COMMAND", 400);
  if (kind === "image" && (typeof altText !== "string" || altText.trim().length === 0)) throw new MediaError("ALT_REQUIRED", 422);
  if (altText !== null && typeof altText !== "string") throw new MediaError("INVALID_MEDIA_COMMAND", 400);
  if (caption !== null && typeof caption !== "string") throw new MediaError("INVALID_MEDIA_COMMAND", 400);
  return { kind, originalFileName, mime, sizeBytes, sha256, altText: altText as string | null, caption: caption as string | null };
}

export async function createUploadGrant(deps: MediaDeps, request: UploadRequest | Record<string, unknown>): Promise<MediaUploadGrant> {
  const config = resolvedConfig(deps);
  const candidate = request as Partial<UploadRequest>;
  if (typeof candidate.roomId !== "string" || typeof candidate.correlationId !== "string") throw new MediaError("INVALID_MEDIA_COMMAND", 400);
  const roomId = candidate.roomId;
  const correlationId = candidate.correlationId;
  const member = await requireStudent(deps, {
    roomId,
    ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
    ...(candidate.principal ? { principal: candidate.principal } : {}),
  });
  const body = normalizedUploadBody(request);
  if (!UUID.test(correlationId)) throw new MediaError("INVALID_MEDIA_COMMAND", 400);
  assertCapabilities(deps.store, config);
  const clock = deps.clock ?? systemClock;
  const repo = resolvedRepo(deps);
  const writeGate = deps.writeGate ?? new DatabaseRoomWriteGate(clock);
  const mediaId = id(deps);
  const grantId = id(deps);
  const stagingKey = `rooms/${roomId}/staging/${grantId}`;

  return repo.withRoomSessionLock(roomId, async (client) => {
    let issuing: { asset: MediaAssetRecord; grant: UploadGrantRow } | undefined;
    try {
      issuing = await transaction(client, async () => {
        await lockRoomInTransaction(client, roomId);
        const room = await client.query<{ status: string; closes_at: Date | null }>("SELECT status, closes_at FROM classroom_room WHERE room_id = $1 FOR UPDATE", [roomId]);
        const closesAt = room.rows[0]?.closes_at;
        if (!room.rows[0] || !["open", "paused"].includes(room.rows[0].status)
          || (closesAt instanceof Date && Number.isFinite(closesAt.getTime()) && closesAt.getTime() <= now(clock).getTime())) {
          throw new MediaError("ROOM_DELETION_IN_PROGRESS", 409);
        }
        await writeGate.assertWritable(client, roomId);
        return repo.insertPendingAssetAndIssuingGrant(client, {
          mediaId, grantId, roomId, ownerActorId: member.actorId,
          kind: body.kind, originalFileName: body.originalFileName, mime: body.mime,
          sizeBytes: body.sizeBytes, sha256: body.sha256, altText: body.altText,
          caption: body.caption, objectKey: stagingKey, correlationId,
          signatureTtlMs: SIGNATURE_TTL_MS, maxUploadRequestMs: config.maxUploadRequestMs,
          maxSignerDbClockSkewMs: config.maxSignerDbClockSkewMs,
        });
      });

      const signed = await deps.store.createUploadUrl({
        objectKey: stagingKey,
        mime: body.mime,
        sizeBytes: body.sizeBytes,
        checksumSha256Base64: hexSha256ToBase64(body.sha256),
        expiresSeconds: SIGNATURE_TTL_MS / 1_000,
      }, makeControl(clock, config.maxPresignMs));
      if (signed.requiredHeaders["x-amz-checksum-sha256"] !== hexSha256ToBase64(body.sha256)) throw new MediaError("STORAGE_CHECKSUM_BINDING_MISMATCH", 502);
      let origin: string;
      try { origin = new URL(signed.url).origin; } catch { throw new MediaError("STORAGE_ORIGIN_NOT_ALLOWED", 502); }
      if (!config.storageBrowserOrigins.includes(origin)) throw new MediaError("STORAGE_ORIGIN_NOT_ALLOWED", 502);
      assertExactSignedWindow(signed, SIGNATURE_TTL_MS / 1_000, issuing.grant.reservedAt, config.maxPresignMs, config.maxSignerDbClockSkewMs);

      const activated = await transaction(client, async () => {
        await lockRoomInTransaction(client, roomId);
        await writeGate.assertWritable(client, roomId);
        return repo.activateGrant(client, grantId, signed, {
          signatureTtlMs: SIGNATURE_TTL_MS,
          maxUploadRequestMs: config.maxUploadRequestMs,
          maxSignerDbClockSkewMs: config.maxSignerDbClockSkewMs,
        });
      });
      return mediaCommandContract.parseUploadGrant({
        mediaId,
        uploadUrl: signed.url,
        requiredHeaders: signed.requiredHeaders,
        expiresAt: activated.expiresAt.toISOString(),
      });
    } catch (error) {
      try {
        await transaction(client, async () => repo.revokeGrant(client, grantId, "GRANT_ISSUE_FAILED"));
      } catch {
        // Preserve the original stable storage/auth error; the revoked row is
        // still bounded by its database-time fence when the rollback races.
      }
      throw error;
    }
  });
}

export async function finalizeUpload(deps: MediaDeps, input: FinalizeInput): Promise<CompleteMediaUploadResponse> {
  const member = await requireStudent(deps, input);
  if (!UUID.test(input.mediaId) || !UUID.test(input.correlationId)) throw new MediaError("INVALID_MEDIA_COMMAND", 400);
  const config = resolvedConfig(deps);
  assertCapabilities(deps.store, config);
  const repo = resolvedRepo(deps);
  const clock = deps.clock ?? systemClock;
  const writeGate = deps.writeGate ?? new DatabaseRoomWriteGate(clock);
  return repo.withRoomSessionLock(input.roomId, async (client) => {
    let locked: LockedMedia;
    await transaction(client, async () => {
      await lockRoomInTransaction(client, input.roomId);
      await writeGate.assertWritable(client, input.roomId);
      const room = await client.query<{ status: string; closes_at: Date | null }>("SELECT status, closes_at FROM classroom_room WHERE room_id = $1 FOR UPDATE", [input.roomId]);
      const closesAt = room.rows[0]?.closes_at;
      if (!room.rows[0] || !["open", "paused"].includes(room.rows[0].status)
        || (closesAt instanceof Date && Number.isFinite(closesAt.getTime()) && closesAt.getTime() <= now(clock).getTime())) {
        throw new MediaError("ROOM_DELETION_IN_PROGRESS", 409);
      }
      locked = await repo.lockOwnedMediaAndGrant(client, input.mediaId, input.roomId, member.actorId);
    });
    if (!locked!) throw new MediaError("MEDIA_NOT_FOUND", 404);
    if (["quarantined", "failed", "deleted"].includes(locked.record.state)) {
      throw new MediaError(`MEDIA_${locked.record.state.toUpperCase()}`, 409);
    }
    if (locked.record.state !== "upload_pending") {
      if (!locked.record.objectKey || !locked.record.sha256) throw new MediaError("OBJECT_IDENTITY_CHANGED", 409);
      const immutable = await deps.store.stat(locked.record.objectKey, makeControl(clock, config.storeHeadTimeoutMs));
      if (immutable.sha256 !== locked.record.sha256 || immutable.sizeBytes !== locked.record.sizeBytes) throw new MediaError("OBJECT_IDENTITY_CHANGED", 409);
      return mediaCommandContract.parseComplete({ mediaId: locked.record.mediaId, state: locked.record.state, enqueued: false });
    }
    if (locked.grant.state !== "active") throw new MediaError("MEDIA_UPLOAD_NOT_SETTLED", 409);
    const expiry = uploadExpiryDecision(locked.grant, now(clock));
    if (expiry.state === "blocked" && locked.grant.expiresAt.getTime() < now(clock).getTime()) throw new MediaError("MEDIA_UPLOAD_EXPIRED", 409);
    const staging = await deps.store.stat(locked.grant.objectKey, makeControl(clock, config.storeHeadTimeoutMs));
    if (staging.objectKey !== locked.grant.objectKey || staging.sizeBytes !== locked.record.sizeBytes || staging.sha256 !== locked.record.declaredSha256) throw new MediaError("OBJECT_IDENTITY_CHANGED", 409);
    const immutableKey = `rooms/${input.roomId}/original/${input.mediaId}`;
    const intent = await transaction(client, async () => {
      await lockRoomInTransaction(client, input.roomId);
      await writeGate.assertWritable(client, input.roomId);
      const latest = await repo.lockOwnedMediaAndGrant(client, input.mediaId, input.roomId, member.actorId);
      const found = latest.grant.promotionCorrelationId;
      if (found && found !== input.correlationId) throw new MediaError("PROMOTION_IDENTITY_MISMATCH", 409);
      return repo.recordPromotionIntent(client, latest.grant, staging, immutableKey, input.correlationId, {
        hardTotalMs: config.storeCopyTimeoutMs,
        settlementMs: config.maxPostAbortSettlementMs,
      });
    });
    await transaction(client, async () => repo.extendPromotionWriteFenceFromDbTime(client, intent.grantId, {
      hardTotalMs: config.storeCopyTimeoutMs,
      settlementMs: config.maxPostAbortSettlementMs,
    }));
    await deps.store.promoteStagingObject({
      stagingKey: intent.objectKey,
      destinationKey: intent.promotionDestinationKey,
      sourceEtag: intent.promotionSourceEtag,
      expectedSha256: intent.promotionSha256,
      ifDestinationAbsent: true,
    }, makeControl(clock, config.storeCopyTimeoutMs));
    const immutable = await deps.store.stat(intent.promotionDestinationKey, makeControl(clock, config.storeHeadTimeoutMs));
    if (immutable.sha256 !== intent.promotionSha256 || immutable.sizeBytes !== locked.record.sizeBytes) throw new MediaError("OBJECT_PROMOTION_MISMATCH", 409);
    const committed = await transaction(client, async () => {
      await lockRoomInTransaction(client, input.roomId);
      await writeGate.assertWritable(client, input.roomId);
      return repo.commitPromotionAndEnqueue(client, {
        mediaId: input.mediaId,
        roomId: input.roomId,
        ownerActorId: member.actorId,
        immutableKey: intent.promotionDestinationKey,
        sha256: immutable.sha256,
        detectedMime: immutable.detectedMime,
        correlationId: intent.promotionCorrelationId,
      });
    });
    return mediaCommandContract.parseComplete({
      mediaId: committed.mediaId,
      state: committed.state,
      enqueued: committed.enqueued,
    });
  });
}

export async function getMediaAttachment(
  deps: MediaDeps,
  input: { readonly sessionId?: string; readonly principal?: AuthSession; readonly roomId: string; readonly mediaId: string },
): Promise<MediaAttachmentView | null> {
  await requireRoomMember(deps, input);
  if (!UUID.test(input.mediaId)) return null;
  return resolvedRepo(deps).getPublicMedia(input.mediaId, input.roomId);
}

export async function createDownloadGrant(
  deps: MediaDeps,
  input: { readonly sessionId?: string; readonly principal?: AuthSession; readonly roomId: string; readonly mediaId: string },
): Promise<MediaDownloadGrant> {
  await requireRoomMember(deps, input);
  if (!UUID.test(input.mediaId)) throw new MediaError("MEDIA_NOT_FOUND", 404);
  const config = resolvedConfig(deps);
  const record = await resolvedRepo(deps).getMedia(input.mediaId, input.roomId);
  if (!record) throw new MediaError("MEDIA_NOT_FOUND", 404);
  if (record.state !== "ready" || !record.objectKey) throw new MediaError("MEDIA_NOT_READY", 409);
  const url = await deps.store.createDownloadUrl({ objectKey: record.objectKey, expiresSeconds: config.storeDownloadTtlSeconds }, makeControl(deps.clock ?? systemClock, config.storeHeadTimeoutMs));
  return mediaCommandContract.parseDownloadGrant({ downloadUrl: url, expiresAt: new Date(now(deps.clock ?? systemClock).getTime() + config.storeDownloadTtlSeconds * 1_000).toISOString() });
}

export { MediaError } from "./media-errors.js";
export { MediaAttachmentValidator } from "./media-attachment-validator.js";
export type { MediaAssetRecord, MediaKind, MediaState } from "./media-asset-record.js";
export { effectiveWriteNotAfter, deriveUploadWriteNotAfter } from "./media-upload-expiry.js";
