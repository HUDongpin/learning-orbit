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

function rowArtifact(row: any): DerivedTextArtifact {
  const value = {
    schemaVersion: 1,
    artifactId: row.artifact_id,
    lineageId: row.lineage_id,
    roomId: row.room_id,
    eventId: row.event_id,
    roomSeq: Number(row.room_seq),
    sourceMediaId: row.source_media_id,
    sourceModality: row.source_modality,
    derivation: row.derivation,
    text: row.text_content,
    normalizedTextSha256: row.normalized_text_sha256,
    sourceConfidenceRaw: Number(row.source_confidence_raw),
    sourceConfidenceCalibrated: row.source_confidence_calibrated === null ? null : Number(row.source_confidence_calibrated),
    provider: row.provider,
    modelVersion: row.model_version,
    languageTag: row.language_tag,
    spans: row.spans,
    reviewStatus: row.review_status,
    displayStatus: row.display_status,
    warnings: row.warnings,
    supersedesArtifactId: row.supersedes_artifact_id,
    active: Boolean(row.active),
    createdAt: new Date(row.created_at).toISOString(),
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
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200) throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_QUERY");
    if (query.afterArtifactId !== undefined) uuid(query.afterArtifactId);
    await this.requireTeacher(principal, sessionId, roomId);
    const values: unknown[] = [roomId];
    const predicates = ["room_id=$1"];
    if (!query.includeHistory) predicates.push("active=true");
    if (query.reviewStatus) { values.push(query.reviewStatus); predicates.push(`review_status=$${values.length}`); }
    if (query.afterArtifactId) { values.push(query.afterArtifactId); predicates.push(`artifact_id>$${values.length}::uuid`); }
    values.push(query.limit + 1);
    const result = await this.pool.query(
      `SELECT artifact_id,lineage_id,room_id,event_id,room_seq,source_media_id,
              source_modality,derivation,text_content,normalized_text_sha256,
              source_confidence_raw,source_confidence_calibrated,provider,model_version,
              language_tag,spans,review_status,display_status,warnings,
              supersedes_artifact_id,active,created_at
       FROM derived_text_artifact WHERE ${predicates.join(" AND ")}
       ORDER BY artifact_id ASC LIMIT $${values.length}`,
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
    const targetProjection = typeof command.targetType === "string" && PROJECTION.has(command.targetType)
      ? command.targetType : null;
    const targetIsProjection = targetProjection !== null || typeof command.targetProjectionEdgeId === "string";
    const targetId = command.targetId ?? command.targetArtifactId ?? command.targetProjectionEdgeId ?? command.targetCorrectionEventId;
    if (targetId !== undefined) uuid(targetId);
    const expectedEpoch = uuid(command.expectedAnalysisEpoch);
    const expectedVersion = command.expectedProjectionVersion;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_REVIEW_COMMAND");
    const isCorrection = typeof command.correctionKind === "string";
    const changeKind = isCorrection ? "correction" : "review";
    const causationId = randomUUID();
    let reviewEventId = "";
    const replayJobId = randomUUID();
    await this.events.transact(roomId, async (context) => {
      const client = context.client;
      const head = targetProjection
        ? await client.query<{ analysis_epoch: string; version: string }>("SELECT analysis_epoch,version FROM analysis_room_heads WHERE room_id=$1 AND projection_key=$2 FOR UPDATE", [roomId, targetProjection])
        : await client.query<{ analysis_epoch: string; version: string }>("SELECT analysis_epoch,version FROM analysis_room_heads WHERE room_id=$1 ORDER BY version DESC LIMIT 1 FOR UPDATE", [roomId]);
      const current = head.rows[0];
      if (!current || current.analysis_epoch !== expectedEpoch || Number(current.version) !== expectedVersion) throw new AnalyticsTeacherError(409, "ANALYTICS_VERSION_CONFLICT");
      if (targetId && !targetIsProjection) {
        const artifact = await client.query("SELECT 1 FROM derived_text_artifact WHERE room_id=$1 AND artifact_id=$2", [roomId, targetId]);
        if (artifact.rowCount !== 1 && command.targetType !== "evidence") throw new AnalyticsTeacherError(404, "ANALYTICS_TARGET_NOT_FOUND");
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
         VALUES($1,$2,$3,$4,$5,$6)`,
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
    return { reviewEventId, changeKind, replayJobId };
  }

  private async requireTeacher(principal: AuthSession | null, sessionId: string | undefined, roomId: string): Promise<void> {
    if (!principal || principal.role !== "teacher") throw new AnalyticsPolicyError(403, "ANALYTICS_TEACHER_ONLY");
    const grant = await this.policy.requireRoomAccess(principal, roomId, "latest", sessionId);
    if (grant.role !== "teacher") throw new AnalyticsPolicyError(403, "ANALYTICS_TEACHER_ONLY");
  }
}
