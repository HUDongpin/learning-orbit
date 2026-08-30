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
const REPLAY_NAMESPACE = Buffer.from("00000000000050008000000000000033", "hex");

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

function uuidV5Text(namespace: Buffer, value: string): string {
  const digest = createHash("sha1").update(namespace).update(value).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function replayIdentity(roomId: string, reason: string, dedupeToken: string): { jobId: string; dedupeKey: string } {
  const dedupeHash = createHash("sha256").update(`${roomId}\0${reason}\0${dedupeToken}`).digest("hex");
  const dedupeKey = `analytics.replay-room.v1:${dedupeHash}`;
  return { jobId: uuidV5Text(REPLAY_NAMESPACE, dedupeKey), dedupeKey };
}

function rowArtifact(row: any): DerivedTextArtifact {
  const roomSeq = row.room_seq === null || row.room_seq === undefined || typeof row.room_seq === "boolean"
    ? Number.NaN : Number(row.room_seq);
  const rawConfidence = row.source_confidence_raw === null || row.source_confidence_raw === undefined
    || typeof row.source_confidence_raw === "boolean" ? Number.NaN : Number(row.source_confidence_raw);
  const calibrated = row.source_confidence_calibrated === null ? null
    : row.source_confidence_calibrated === undefined || typeof row.source_confidence_calibrated === "boolean"
      ? Number.NaN : Number(row.source_confidence_calibrated);
  if (typeof row.active !== "boolean") throw new AnalyticsTeacherError(503, "ANALYTICS_CORRUPT");
  if (row.created_at === null || row.created_at === undefined) throw new AnalyticsTeacherError(503, "ANALYTICS_CORRUPT");
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
    active: row.active,
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
    if (typeof query.includeHistory !== "boolean"
      || (query.reviewStatus !== undefined
        && !["unreviewed", "approved", "rejected", "corrected"].includes(query.reviewStatus))) {
      throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_QUERY");
    }
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_QUERY");
    if (query.afterArtifactId !== undefined) uuid(query.afterArtifactId);
    await this.requireTeacher(principal, sessionId, roomId);
    const values: unknown[] = [roomId];
    const predicates = ["room_id=$1"];
    if (!query.includeHistory) predicates.push("active=true");
    if (query.reviewStatus !== undefined) {
      values.push(query.reviewStatus);
      predicates.push(`review_status=$${values.length}`);
    }
    if (query.afterArtifactId) {
      const cursorPredicates = ["room_id=$1", "artifact_id=$2::uuid"];
      const cursorValues: unknown[] = [roomId, query.afterArtifactId];
      if (!query.includeHistory) cursorPredicates.push("active=true");
      if (query.reviewStatus !== undefined) {
        cursorValues.push(query.reviewStatus);
        cursorPredicates.push(`review_status=$${cursorValues.length}`);
      }
      const cursor = await this.pool.query<{ created_at: Date }>(
        `SELECT created_at FROM derived_text_artifact
         WHERE ${cursorPredicates.join(" AND ")}`,
        cursorValues,
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
    let replayJobId = "";
    await this.events.transact(roomId, async (context) => {
      const client = context.client;
      // Idempotency is checked before the optimistic head CAS.  A retry may
      // arrive after the first command has already triggered a replay (and
      // therefore changed the visible epoch/version); it must still resolve
      // to the original immutable fact instead of being misreported as a
      // version conflict.  The causation lookup is room-scoped and the
      // append-only detail/replay rows are repaired idempotently if a prior
      // response was lost between transaction steps.
      const existing = typeof context.findByCausation === "function"
        ? await context.findByCausation(causationId) : null;
      if (existing) {
        const expectedType = isCorrection
          ? "analytics.correction.recorded.v1"
          : "analytics.review.recorded.v1";
        if (existing.type !== expectedType || existing.actorId !== principal.teacherId
          || existing.actorKind !== "human" || existing.actorRole !== "teacher") {
          throw new AnalyticsTeacherError(409, "ANALYTICS_VERSION_CONFLICT");
        }
        reviewEventId = existing.eventId;
        const replay = replayIdentity(roomId, "analytics_review", existing.eventId);
        replayJobId = replay.jobId;
        await client.query(
          `INSERT INTO analytics_review_detail(review_detail_id,review_event_id,room_id,change_kind,validated_payload,reviewer_teacher_id)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT (review_event_id) DO NOTHING`,
          [randomUUID(), existing.eventId, roomId, changeKind, command, principal.teacherId],
        );
        const requestedThrough = existing.roomSeq;
        const dedupe = replay.dedupeKey;
        await client.query(
          `INSERT INTO worker_job(job_id,job_type,room_id,source_event_id,dedupe_key,correlation_id,payload,analytics_order_seq,analytics_order_kind)
           VALUES($1,'analytics.replay-room.v1',$2,$3,$4,$5,$6,$7,1) ON CONFLICT(dedupe_key) DO NOTHING`,
          [replayJobId, roomId, existing.eventId, dedupe, existing.correlationId,
            { reason: "analytics_review", requestedThroughRoomSeq: requestedThrough }, requestedThrough],
        );
        await client.query(
          `INSERT INTO analytics_replay_request(job_id,room_id,source_event_id,reason,requested_through_room_seq,dedupe_key,correlation_id)
           VALUES($1,$2,$3,'analytics_review',$4,$5,$6) ON CONFLICT(job_id) DO NOTHING`,
          [replayJobId, roomId, existing.eventId, requestedThrough, dedupe, existing.correlationId],
        );
        return;
      }
      const head = await client.query<{ analysis_epoch: string; version: string }>(
        "SELECT analysis_epoch,version FROM analysis_room_heads WHERE room_id=$1 AND projection_key=$2 FOR UPDATE",
        [roomId, ECHO_TEACHER_PROJECTION],
      );
      const current = head.rows[0];
      if (!current || current.analysis_epoch !== expectedEpoch || Number(current.version) !== expectedVersion) throw new AnalyticsTeacherError(409, "ANALYTICS_VERSION_CONFLICT");
      const targetNotFound = () => { throw new AnalyticsTeacherError(404, "ANALYTICS_TARGET_NOT_FOUND"); };
      const snapshotPayload = async (): Promise<Record<string, any>> => {
        const result = await client.query<{ payload: unknown }>(
          `SELECT s.payload
             FROM analysis_projection_snapshots s
             JOIN analysis_room_heads h ON h.snapshot_id=s.snapshot_id
            WHERE h.room_id=$1 AND h.projection_key=$2
              AND h.analysis_epoch=$3 AND h.version=$4`,
          [roomId, ECHO_TEACHER_PROJECTION, expectedEpoch, expectedVersion],
        );
        const payload = result.rows[0]?.payload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) targetNotFound();
        return payload as Record<string, any>;
      };
      const snapshotNodes = async (): Promise<Set<string>> => {
        const payload = await snapshotPayload();
        return new Set(Array.isArray(payload.nodes)
          ? payload.nodes.filter((node) => node && typeof node.nodeId === "string").map((node) => node.nodeId)
          : []);
      };
      const snapshotEdge = async (edgeId: string): Promise<Record<string, any>> => {
        const payload = await snapshotPayload();
        const edge = Array.isArray(payload.edges)
          ? payload.edges.find((item) => item && item.edgeId === edgeId) : undefined;
        if (!edge || typeof edge !== "object") targetNotFound();
        return edge as Record<string, any>;
      };
      const eventPayload = async (eventId: string): Promise<Record<string, any>> => {
        const result = await client.query<{ payload: unknown }>(
          "SELECT payload FROM room_event WHERE room_id=$1 AND event_id=$2", [roomId, eventId],
        );
        const payload = result.rows[0]?.payload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) targetNotFound();
        return payload as Record<string, any>;
      };
      const assertSpan = async (ref: Record<string, any>): Promise<void> => {
        if (typeof ref.eventId !== "string" || !UUID.test(ref.eventId)
          || !Number.isSafeInteger(ref.start) || ref.start < 0
          || !Number.isSafeInteger(ref.end) || ref.end <= ref.start) {
          throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_REVIEW_COMMAND");
        }
        const payload = await eventPayload(ref.eventId);
        const text = typeof payload.text === "string" ? payload.text : "";
        if (ref.end > text.length) throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_REVIEW_COMMAND");
      };

      // Resolve every correction target against the locked teacher shadow
      // snapshot and the same room.  The generated union guarantees branch
      // shape; these checks guarantee provenance, span bounds and alias
      // identity before an append-only fact can be written.
      if (command.correctionKind === "replace_text") {
        const target = await client.query(
          "SELECT 1 FROM derived_text_artifact WHERE room_id=$1 AND artifact_id=$2 AND active=true",
          [roomId, command.targetArtifactId],
        );
        if (target.rowCount !== 1) targetNotFound();
      } else if (command.correctionKind === "replace_evidence_span") {
        const edge = await snapshotEdge(command.targetProjectionEdgeId);
        const target = command.target;
        const replacement = command.replacement;
        const refs = Array.isArray(edge.evidenceRefs) ? edge.evidenceRefs : [];
        if (!refs.some((ref) => ref && ref.eventId === target.eventId
          && ref.start === target.start && ref.end === target.end)) targetNotFound();
        await assertSpan(target);
        await assertSpan(replacement);
      } else if (command.correctionKind === "replace_relation") {
        await snapshotEdge(command.targetProjectionEdgeId);
        const nodes = await snapshotNodes();
        if (!nodes.has(command.replacement.head) || !nodes.has(command.replacement.tail)) targetNotFound();
      } else if (command.correctionKind === "merge_alias") {
        if (command.targetCanonicalNodeId === command.replacement.aliasNodeId) {
          throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_REVIEW_COMMAND");
        }
        const nodes = await snapshotNodes();
        if (!nodes.has(command.targetCanonicalNodeId) || !nodes.has(command.replacement.aliasNodeId)) targetNotFound();
      } else if (command.correctionKind === "split_alias") {
        const { aliasNodeId, newCanonicalNodeId } = command.replacement;
        if (command.targetCanonicalNodeId === aliasNodeId
          || command.targetCanonicalNodeId === newCanonicalNodeId
          || aliasNodeId === newCanonicalNodeId) {
          throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_REVIEW_COMMAND");
        }
        const nodes = await snapshotNodes();
        if (!nodes.has(command.targetCanonicalNodeId) || !nodes.has(aliasNodeId)) targetNotFound();
      } else if (command.correctionKind === "undo_merge") {
        const prior = await client.query<{ validated_payload: unknown }>(
          `SELECT validated_payload FROM analytics_review_detail
            WHERE room_id=$1 AND review_event_id=$2 AND change_kind='correction'`,
          [roomId, command.targetCorrectionEventId],
        );
        const payload = prior.rows[0]?.validated_payload;
        if (!payload || typeof payload !== "object" || (payload as Record<string, any>).correctionKind !== "merge_alias") targetNotFound();
      } else if (command.correctionKind === "retract") {
        if (command.targetType === "projection") {
          const edgeId = command.targetId;
          await snapshotEdge(edgeId);
        } else if (command.targetType === "evidence") {
          const found = await client.query("SELECT 1 FROM room_event WHERE room_id=$1 AND event_id=$2", [roomId, command.targetId]);
          if (found.rowCount !== 1) targetNotFound();
        } else {
          const found = await client.query("SELECT 1 FROM derived_text_artifact WHERE room_id=$1 AND artifact_id=$2", [roomId, command.targetId]);
          if (found.rowCount !== 1) targetNotFound();
        }
      } else if (targetId && !targetIsProjection) {
        const targetResult = command.targetType === "evidence"
          ? await client.query("SELECT 1 FROM room_event WHERE room_id=$1 AND event_id=$2", [roomId, targetId])
          : await client.query("SELECT 1 FROM derived_text_artifact WHERE room_id=$1 AND artifact_id=$2", [roomId, targetId]);
        if (targetResult.rowCount !== 1) targetNotFound();
      } else if (targetIsProjection) {
        const edgeId = command.targetProjectionEdgeId
          ?? (command.targetType === "projection" ? command.targetId : undefined);
        if (edgeId) await snapshotEdge(edgeId);
        if (command.targetCanonicalNodeId) {
          const nodes = await snapshotNodes();
          if (!nodes.has(command.targetCanonicalNodeId)) targetNotFound();
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
      const replay = replayIdentity(roomId, "analytics_review", event.eventId);
      replayJobId = replay.jobId;
      await client.query(
        `INSERT INTO analytics_review_detail(review_detail_id,review_event_id,room_id,change_kind,validated_payload,reviewer_teacher_id)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (review_event_id) DO NOTHING`,
        [randomUUID(), event.eventId, roomId, changeKind, command, principal.teacherId],
      );
      const requestedThrough = event.roomSeq;
      const dedupe = replay.dedupeKey;
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
      [replayIdentity(roomId, "analytics_review", reviewEventId).dedupeKey],
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
