import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  analyticsContract,
  type AuthSession,
  type DerivedTextArtifact,
} from "@learning-orbit/contracts";
import type { RoomEventRepository } from "../rooms/room-event-repository.js";
import type { AnalyticsPolicy } from "./analytics-policy.js";
import { AnalyticsPolicyError } from "./analytics-policy.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECTION = new Set(["echo.teacher_shadow", "echo.student_approved", "trace.teacher_bundle", "trace.student_bundle"]);
const ECHO_TEACHER_PROJECTION = "echo.teacher_shadow" as const;
const REVIEW_NAMESPACE = Buffer.from("9f5d0c784d6e4f0e8a5c1b2d3e4f5061", "hex");

export class AnalyticsTeacherError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409 | 503, readonly code: string) { super(code); }
}

export interface ArtifactQuery {
  reviewStatus?: "unreviewed" | "approved" | "rejected" | "corrected";
  afterArtifactId?: string;
  includeHistory: boolean;
  limit: number;
}

export interface ArtifactPage {
  items: DerivedTextArtifact[];
  throughRoomSeq: number;
  nextAfterArtifactId: string | null;
  includeHistory: boolean;
}

function uuid(value: unknown, code = "INVALID_ANALYTICS_QUERY"): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new AnalyticsTeacherError(400, code);
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function uuidV5(namespace: Buffer, value: unknown): string {
  const digest = createHash("sha1").update(namespace).update(stableJson(value)).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rowArtifact(row: any): DerivedTextArtifact {
  const roomSeq = Number(row.room_seq);
  const rawConfidence = Number(row.source_confidence_raw);
  const calibrated = row.source_confidence_calibrated === null ? null : Number(row.source_confidence_calibrated);
  const created = new Date(row.created_at);
  if (!Number.isSafeInteger(roomSeq) || roomSeq < 1
    || !Number.isFinite(rawConfidence) || (calibrated !== null && !Number.isFinite(calibrated))
    || !Number.isFinite(created.getTime())) {
    throw new AnalyticsTeacherError(503, "ANALYTICS_CORRUPT");
  }
  const value = {
    schemaVersion: 1,
    artifactId: row.artifact_id,
    lineageId: row.lineage_id,
    roomId: row.room_id,
    eventId: row.event_id,
    roomSeq,
    sourceMediaId: row.source_media_id,
    sourceModality: row.source_modality,
    derivation: row.derivation,
    text: row.text_content,
    normalizedTextSha256: row.normalized_text_sha256,
    sourceConfidenceRaw: rawConfidence,
    sourceConfidenceCalibrated: calibrated,
    provider: row.provider,
    modelVersion: row.model_version,
    languageTag: row.language_tag,
    spans: row.spans,
    reviewStatus: row.review_status,
    displayStatus: row.display_status,
    warnings: row.warnings,
    supersedesArtifactId: row.supersedes_artifact_id,
    active: Boolean(row.active),
    createdAt: created.toISOString(),
  };
  try { return analyticsContract.parseArtifact(value); }
  catch { throw new AnalyticsTeacherError(503, "ANALYTICS_CORRUPT"); }
}

export class AnalyticsTeacherService {
  constructor(
    private readonly pool: Pool,
    private readonly events: RoomEventRepository,
    private readonly policy: AnalyticsPolicy,
  ) {}

  async listArtifacts(
    principal: AuthSession | null, sessionId: string | undefined,
    roomId: string, query: ArtifactQuery,
  ): Promise<ArtifactPage> {
    uuid(roomId);
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_QUERY");
    if (query.afterArtifactId !== undefined) uuid(query.afterArtifactId);
    await this.requireTeacher(principal, sessionId, roomId);
    const values: unknown[] = [roomId, query.reviewStatus ?? "unreviewed"];
    const predicates = ["room_id=$1"];
    if (!query.includeHistory) predicates.push("active=true");
    predicates.push("review_status=$2");
    if (query.afterArtifactId) {
      const cursor = await this.pool.query<{ created_at: Date }>(
        `SELECT created_at FROM derived_text_artifact
         WHERE room_id=$1 AND review_status=$2 AND artifact_id=$3::uuid
           AND ($4::boolean OR active=true)`,
        [roomId, query.reviewStatus ?? "unreviewed", query.afterArtifactId, query.includeHistory],
      );
      const cursorDate = cursor.rows[0]?.created_at;
      if (!(cursorDate instanceof Date) || !Number.isFinite(cursorDate.getTime())) {
        throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_QUERY");
      }
      values.push(cursorDate, query.afterArtifactId);
      predicates.push(`(created_at,artifact_id) > ($${values.length - 1}::timestamptz,$${values.length}::uuid)`);
    }
    values.push(query.limit + 1);
    const result = await this.pool.query(
      `SELECT artifact_id,lineage_id,room_id,event_id,room_seq,source_media_id,
              source_modality,derivation,text_content,normalized_text_sha256,
              source_confidence_raw,source_confidence_calibrated,provider,model_version,
              language_tag,spans,review_status,display_status,warnings,
              supersedes_artifact_id,active,created_at
       FROM derived_text_artifact WHERE ${predicates.join(" AND ")}
       ORDER BY created_at ASC, artifact_id ASC LIMIT $${values.length}`,
      values,
    );
    const rows = result.rows.slice(0, query.limit).map(rowArtifact);
    const hasMore = result.rows.length > query.limit;
    return analyticsContract.parseArtifactPage({
      items: rows,
      throughRoomSeq: rows.reduce((max, row) => Math.max(max, row.roomSeq), 0),
      nextAfterArtifactId: hasMore ? rows.at(-1)?.artifactId ?? null : null,
      includeHistory: query.includeHistory,
    });
  }

  async review(
    principal: AuthSession | null, sessionId: string | undefined,
    roomId: string, input: unknown,
  ): Promise<{ reviewEventId: string; changeKind: "review" | "correction"; replayJobId: string }> {
    uuid(roomId);
    if (!principal || principal.role !== "teacher") throw new AnalyticsPolicyError(403, "ANALYTICS_TEACHER_ONLY");
    const command = (() => { try { return analyticsContract.parseReview(input) as Record<string, any>; } catch { throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_REVIEW_COMMAND"); } })();
    await this.requireTeacher(principal, sessionId, roomId);
    // All review/correction version checks are against the teacher ECHO
    // shadow head.  TRACE is an atomic social-structure bundle and is never a
    // student-approval target in this endpoint.
    const targetProjection = ECHO_TEACHER_PROJECTION;
    const targetIsProjection = command.targetType === "projection"
      || typeof command.targetProjectionEdgeId === "string"
      || typeof command.targetCanonicalNodeId === "string";
    const targetId = command.targetId ?? command.targetArtifactId ?? command.targetProjectionEdgeId ?? command.targetCorrectionEventId;
    if (targetId !== undefined) uuid(targetId);
    const expectedEpoch = uuid(command.expectedAnalysisEpoch);
    const expectedVersion = command.expectedProjectionVersion;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_REVIEW_COMMAND");
    const isCorrection = typeof command.correctionKind === "string";
    const changeKind = isCorrection ? "correction" : "review";
    const causationId = uuidV5(REVIEW_NAMESPACE, [roomId, principal.teacherId, command]);
    let reviewEventId = "";
    const replayJobId = uuidV5(REVIEW_NAMESPACE, ["replay", roomId, causationId]);
    await this.events.transact(roomId, async (context) => {
      const client = context.client;
      const head = await client.query<{ analysis_epoch: string; version: string }>(
        "SELECT analysis_epoch,version FROM analysis_room_heads WHERE room_id=$1 AND projection_key=$2 FOR UPDATE",
        [roomId, ECHO_TEACHER_PROJECTION],
      );
      const current = head.rows[0];
      if (!current || current.analysis_epoch !== expectedEpoch || Number(current.version) !== expectedVersion) throw new AnalyticsTeacherError(409, "ANALYTICS_VERSION_CONFLICT");
      if (targetId && !targetIsProjection) {
        const targetResult = command.correctionKind === "undo_merge"
          ? await client.query("SELECT 1 FROM analytics_review_detail d WHERE d.room_id=$1 AND d.review_event_id=$2 AND d.change_kind='correction'", [roomId, targetId])
          : command.targetType === "evidence"
          ? await client.query("SELECT 1 FROM room_event WHERE room_id=$1 AND event_id=$2", [roomId, targetId])
          : await client.query("SELECT 1 FROM derived_text_artifact WHERE room_id=$1 AND artifact_id=$2", [roomId, targetId]);
        if (targetResult.rowCount !== 1) throw new AnalyticsTeacherError(404, "ANALYTICS_TARGET_NOT_FOUND");
      }
      if (targetIsProjection) {
        const edgeId = command.targetProjectionEdgeId
          ?? (command.targetType === "projection" ? command.targetId : undefined);
        if (edgeId) {
          const edge = await client.query(
            `SELECT 1
             FROM analysis_projection_snapshots s
             JOIN analysis_room_heads h ON h.snapshot_id=s.snapshot_id
             CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.payload->'edges','[]'::jsonb)) item
             WHERE h.room_id=$1 AND h.projection_key=$2
               AND item->>'edgeId'=$3`,
            [roomId, ECHO_TEACHER_PROJECTION, edgeId],
          );
          if (edge.rowCount !== 1) throw new AnalyticsTeacherError(404, "ANALYTICS_TARGET_NOT_FOUND");
        }
        if (command.targetCanonicalNodeId) {
          const node = await client.query(
            `SELECT 1
             FROM analysis_projection_snapshots s
             JOIN analysis_room_heads h ON h.snapshot_id=s.snapshot_id
             CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.payload->'nodes','[]'::jsonb)) item
             WHERE h.room_id=$1 AND h.projection_key=$2
               AND item->>'nodeId'=$3`,
            [roomId, ECHO_TEACHER_PROJECTION, command.targetCanonicalNodeId],
          );
          if (node.rowCount !== 1) throw new AnalyticsTeacherError(404, "ANALYTICS_TARGET_NOT_FOUND");
        }
      }
      const event = await context.append({
        type: isCorrection ? "analytics.correction.recorded.v1" : "analytics.review.recorded.v1",
        actorId: principal.teacherId,
        actorKind: "human", actorRole: "teacher", revision: 1, operation: "add",
        eventTime: new Date(), causationId, correlationId: causationId,
        payload: { changeKind },
      });
      reviewEventId = event.eventId;
      await client.query(
        `INSERT INTO analytics_review_detail(review_detail_id,review_event_id,room_id,change_kind,validated_payload,reviewer_teacher_id)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (review_event_id) DO NOTHING`,
        [randomUUID(), event.eventId, roomId, changeKind, command, principal.teacherId],
      );
      const requestedThrough = event.roomSeq;
      const dedupe = `analytics.replay-room.v1:${roomId}:${event.eventId}`;
      await client.query(
        `INSERT INTO worker_job(job_id,job_type,room_id,source_event_id,dedupe_key,correlation_id,payload,analytics_order_seq,analytics_order_kind)
        VALUES($1,'analytics.replay-room.v1',$2,$3,$4,$5,$6,$7,1) ON CONFLICT(dedupe_key) DO NOTHING`,
        [replayJobId, roomId, event.eventId, dedupe, event.correlationId,
          { reason: "analytics_review", requestedThroughRoomSeq: requestedThrough }, requestedThrough],
      );
      await client.query(
        `INSERT INTO analytics_replay_request(job_id,room_id,source_event_id,reason,requested_through_room_seq,dedupe_key,correlation_id)
         VALUES($1,$2,$3,'analytics_review',$4,$5,$6) ON CONFLICT(job_id) DO NOTHING`,
        [replayJobId, roomId, event.eventId, requestedThrough, dedupe, event.correlationId],
      );
    });
    const replay = await this.pool.query<{ job_id: string }>(
      "SELECT job_id FROM worker_job WHERE dedupe_key=$1",
      [`analytics.replay-room.v1:${roomId}:${reviewEventId}`],
    );
    return { reviewEventId, changeKind, replayJobId: replay.rows[0]?.job_id ?? replayJobId };
  }

  async reviewDetail(
    principal: AuthSession | null, sessionId: string | undefined,
    roomId: string, reviewEventId: string,
  ): Promise<Record<string, unknown>> {
    uuid(roomId);
    uuid(reviewEventId, "INVALID_ANALYTICS_QUERY");
    await this.requireTeacher(principal, sessionId, roomId);
    const result = await this.pool.query<{
      review_event_id: string; room_id: string; change_kind: "review" | "correction";
      validated_payload: unknown; reviewer_teacher_id: string; created_at: Date;
    }>(
      `SELECT review_event_id,room_id,change_kind,validated_payload,reviewer_teacher_id,created_at
       FROM analytics_review_detail
       WHERE room_id=$1 AND review_event_id=$2`,
      [roomId, reviewEventId],
    );
    const row = result.rows[0];
    if (!row) throw new AnalyticsTeacherError(404, "ANALYTICS_REVIEW_NOT_FOUND");
    let payload: unknown;
    try { payload = analyticsContract.parseReview(row.validated_payload); }
    catch { throw new AnalyticsTeacherError(503, "ANALYTICS_CORRUPT"); }
    if (!(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime())) {
      throw new AnalyticsTeacherError(503, "ANALYTICS_CORRUPT");
    }
    return {
      reviewEventId: row.review_event_id,
      roomId: row.room_id,
      changeKind: row.change_kind,
      payload,
      reviewerTeacherId: row.reviewer_teacher_id,
      createdAt: row.created_at.toISOString(),
    };
  }

  private async requireTeacher(principal: AuthSession | null, sessionId: string | undefined, roomId: string): Promise<void> {
    if (!principal) throw new AnalyticsPolicyError(401, "AUTH_REQUIRED");
    if (principal.role !== "teacher") throw new AnalyticsPolicyError(403, "ANALYTICS_TEACHER_ONLY");
    const grant = await this.policy.requireRoomAccess(principal, roomId, "latest", sessionId);
    if (grant.role !== "teacher") throw new AnalyticsPolicyError(403, "ANALYTICS_TEACHER_ONLY");
  }
}
