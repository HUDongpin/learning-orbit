import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  analyticsContract,
  analyticsTeacherHttpContract,
  type AuthSession,
  type AnalyticsReviewAccepted,
  type AnalyticsReviewCommand,
  type AnalyticsReviewDetail,
  type ApiError,
  type DerivedTextArtifact,
} from "@learning-orbit/contracts";
import type { RoomEventRepository } from "../rooms/room-event-repository.js";
import type { AnalyticsPolicy } from "./analytics-policy.js";
import { AnalyticsPolicyError } from "./analytics-policy.js";
import { inTransaction } from "../../db/transactions.js";
import { lockRoomInTransaction } from "../rooms/room-lock.js";
import { RoomError } from "../rooms/errors.js";
import {
  AnalyticsRepository,
  AnalyticsRepositoryError,
  projectionWire,
} from "./analytics-repository.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECTION = new Set(["echo.teacher_shadow", "echo.student_approved", "trace.teacher_bundle", "trace.student_bundle"]);
const ECHO_TEACHER_PROJECTION = "echo.teacher_shadow" as const;
const REVIEW_NAMESPACE = Buffer.from("9f5d0c784d6e4f0e8a5c1b2d3e4f5061", "hex");
const REPLAY_NAMESPACE = Buffer.from("00000000000050008000000000000033", "hex");

export class AnalyticsTeacherError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409 | 410 | 503, readonly code: ApiError["code"]) { super(code); }
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

function uuid(value: unknown, code: ApiError["code"] = "INVALID_ANALYTICS_QUERY"): string {
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

function parseArtifactQuery(value: unknown): ArtifactQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_QUERY");
  }
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some((key) => !["reviewStatus", "afterArtifactId", "includeHistory", "limit"].includes(key))) {
    throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_QUERY");
  }
  const reviewStatus = query.reviewStatus ?? "unreviewed";
  if (typeof reviewStatus !== "string"
    || !["unreviewed", "approved", "rejected", "corrected"].includes(reviewStatus)) {
    throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_QUERY");
  }
  const includeHistory = query.includeHistory === undefined ? false
    : query.includeHistory === true || query.includeHistory === "true" ? true
      : query.includeHistory === false || query.includeHistory === "false" ? false
        : undefined;
  if (includeHistory === undefined) throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_QUERY");
  const rawLimit = query.limit ?? 50;
  const limit = typeof rawLimit === "number" ? rawLimit
    : typeof rawLimit === "string" && /^(?:[1-9][0-9]{0,2})$/u.test(rawLimit) ? Number(rawLimit)
      : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_QUERY");
  }
  if (query.afterArtifactId !== undefined) uuid(query.afterArtifactId);
  const parsed: ArtifactQuery = {
    includeHistory,
    limit,
    reviewStatus: reviewStatus as NonNullable<ArtifactQuery["reviewStatus"]>,
  };
  if (typeof query.afterArtifactId === "string") parsed.afterArtifactId = query.afterArtifactId;
  return parsed;
}

export class AnalyticsTeacherService {
  constructor(
    private readonly pool: Pool,
    private readonly events: RoomEventRepository,
    private readonly policy: AnalyticsPolicy,
  ) {}

  /**
   * Route-level pre-parse authorization.  Mutating methods still repeat this
   * check at their transactional boundary; this method exists so malformed
   * JSON cannot make an anonymous, student, or cross-room caller observe a
   * parser error before the hidden-resource policy is applied.
   */
  async authorize(
    principal: AuthSession | null,
    sessionId: string | undefined,
    roomId: string,
  ): Promise<void> {
    await this.requireTeacher(principal, sessionId, roomId);
  }

  async listArtifacts(
    principal: AuthSession | null, sessionId: string | undefined,
    roomId: string, rawQuery: unknown,
  ): Promise<ArtifactPage> {
    await this.requireTeacher(principal, sessionId, roomId);
    const query = parseArtifactQuery(rawQuery);
    return inTransaction(this.pool, async (tx) => {
      await lockRoomInTransaction(tx, roomId);
      await this.assertNotDeleting(tx, roomId);
      await this.assertRetentionCurrent(tx, roomId);
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
        const cursor = await tx.query<{ created_at: Date }>(
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
      const result = await tx.query(
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
    });
  }

  async review(
    principal: AuthSession | null, sessionId: string | undefined,
    roomId: string, input: unknown,
  ): Promise<AnalyticsReviewAccepted & { readonly created: boolean }> {
    const teacher = await this.requireTeacher(principal, sessionId, roomId);
    const parsedCommand = (() => { try { return analyticsContract.parseReview(input); } catch { throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_REVIEW_COMMAND"); } })();
    // Keep the closed generated union as the validation and public typing
    // boundary.  The target-resolution matrix below intentionally reads the
    // mutually exclusive branch fields by name after that parser has removed
    // the possibility of mixed or additional properties.
    const command = parsedCommand as unknown as Record<string, any>;
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
    const causationId = uuidV5(REVIEW_NAMESPACE, [roomId, teacher.teacherId, command]);
    let reviewEventId = "";
    let replayJobId = "";
    let created = true;
    try {
      await this.events.transact(roomId, async (context) => {
      const client = context.client;
      if (context.room.teacher_id !== teacher.teacherId) {
        throw new AnalyticsTeacherError(404, "ROOM_NOT_FOUND");
      }
      await this.assertNotDeleting(client, roomId);
      await this.assertRetentionCurrent(client, roomId);
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
        created = false;
        const expectedType = isCorrection
          ? "analytics.correction.recorded.v1"
          : "analytics.review.recorded.v1";
        if (existing.type !== expectedType || existing.actorId !== teacher.teacherId
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
          [randomUUID(), existing.eventId, roomId, changeKind, command, teacher.teacherId],
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
      const head = await client.query<{
        analysis_epoch: string;
        version: string;
        complete_through_seq: string;
        requires_replay: boolean;
      }>(
        "SELECT analysis_epoch,version,complete_through_seq,requires_replay FROM analysis_room_heads WHERE room_id=$1 AND projection_key=$2 FOR UPDATE",
        [roomId, ECHO_TEACHER_PROJECTION],
      );
      const current = head.rows[0];
      if (!current || current.analysis_epoch !== expectedEpoch || Number(current.version) !== expectedVersion) throw new AnalyticsTeacherError(409, "ANALYTICS_VERSION_CONFLICT");
      const projectedThrough = Number(current.complete_through_seq);
      const roomThrough = context.room.next_room_seq - 1;
      if (!Number.isSafeInteger(projectedThrough) || projectedThrough < 0
        || !Number.isSafeInteger(roomThrough) || roomThrough < 0
        || typeof current.requires_replay !== "boolean") {
        throw new AnalyticsTeacherError(503, "ANALYTICS_CORRUPT");
      }
      // A projection authority can authorize at most one new immutable review
      // fact. Until replay advances complete_through_seq, accepting a second
      // distinct command against the same head would let target-changing
      // corrections race and make the later replay unrecoverable.
      if (current.requires_replay || projectedThrough !== roomThrough) {
        throw new AnalyticsTeacherError(409, "ANALYTICS_VERSION_CONFLICT");
      }
      const targetNotFound = () => { throw new AnalyticsTeacherError(404, "ANALYTICS_TARGET_NOT_FOUND"); };
      let validatedSnapshotPayload: Record<string, any> | undefined;
      const snapshotPayload = async (): Promise<Record<string, any>> => {
        if (validatedSnapshotPayload) return validatedSnapshotPayload;
        try {
          const repository = new AnalyticsRepository(client as unknown as Pool, {
            callerHoldsCanonicalRoomLock: true,
          });
          const row = await repository.latest(roomId, ECHO_TEACHER_PROJECTION);
          if (!row || row.analysisEpoch !== expectedEpoch || row.version !== expectedVersion
            || row.completeThroughRoomSeq !== projectedThrough || row.requiresReplay !== false) {
            throw new AnalyticsRepositoryError();
          }
          const snapshot = analyticsContract.parseTeacherEchoSnapshot(projectionWire(row));
          validatedSnapshotPayload = snapshot.payload as Record<string, any>;
          return validatedSnapshotPayload;
        } catch {
          throw new AnalyticsTeacherError(503, "ANALYTICS_CORRUPT");
        }
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
      const activeTextLengths = new Map<string, readonly number[]>();
      const textLengthsForEvidence = async (eventId: string): Promise<readonly number[]> => {
        const cached = activeTextLengths.get(eventId);
        if (cached) return cached;
        const result = await client.query<{ text_content: unknown }>(
          `SELECT active.text_content
             FROM derived_text_artifact source
             JOIN derived_text_artifact active
               ON active.room_id=source.room_id
              AND active.lineage_id=source.lineage_id
              AND active.active=true
            WHERE source.room_id=$1 AND source.event_id=$2
            ORDER BY active.artifact_id`,
          [roomId, eventId],
        );
        if (result.rows.length === 0) targetNotFound();
        const lengths = result.rows.map(({ text_content: text }) => {
          if (typeof text !== "string" || text.length < 1 || text.length > 20_000) {
            throw new AnalyticsTeacherError(503, "ANALYTICS_CORRUPT");
          }
          // Worker offsets are Python Unicode code-point offsets.  JavaScript
          // string.length counts UTF-16 code units and would reject valid
          // spans containing astral characters, so keep this boundary aligned
          // with the normalized worker text.
          return Array.from(text).length;
        });
        activeTextLengths.set(eventId, lengths);
        return lengths;
      };
      const assertSpan = async (ref: Record<string, any>): Promise<void> => {
        if (typeof ref.eventId !== "string" || !UUID.test(ref.eventId)
          || !Number.isSafeInteger(ref.start) || ref.start < 0
          || !Number.isSafeInteger(ref.end) || ref.end <= ref.start) {
          throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_REVIEW_COMMAND");
        }
        const lengths = await textLengthsForEvidence(ref.eventId);
        if (!lengths.some((length) => ref.end <= length)) {
          throw new AnalyticsTeacherError(400, "INVALID_ANALYTICS_REVIEW_COMMAND");
        }
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
        if (!nodes.has(command.targetCanonicalNodeId) || !nodes.has(aliasNodeId)
          || nodes.has(newCanonicalNodeId)) targetNotFound();
      } else if (command.correctionKind === "undo_merge") {
        const prior = await client.query<{ validated_payload: unknown; room_seq: string }>(
          `SELECT d.validated_payload,e.room_seq
             FROM analytics_review_detail d
             JOIN room_event e ON e.event_id=d.review_event_id AND e.room_id=d.room_id
            WHERE d.room_id=$1 AND d.review_event_id=$2 AND d.change_kind='correction'`,
          [roomId, command.targetCorrectionEventId],
        );
        let payload: Extract<AnalyticsReviewCommand, { correctionKind: "merge_alias" }> | null = null;
        try {
          const parsed = analyticsContract.parseReview(prior.rows[0]?.validated_payload);
          if ("correctionKind" in parsed && parsed.correctionKind === "merge_alias") payload = parsed;
        } catch { /* hidden as an absent target below */ }
        if (!payload) throw new AnalyticsTeacherError(404, "ANALYTICS_TARGET_NOT_FOUND");
        const priorRoomSeq = Number(prior.rows[0]?.room_seq);
        if (!Number.isSafeInteger(priorRoomSeq) || priorRoomSeq < 1) targetNotFound();
        const alreadyUndone = await client.query(
          `SELECT 1 FROM analytics_review_detail
            WHERE room_id=$1 AND change_kind='correction'
              AND validated_payload->>'correctionKind'='undo_merge'
              AND validated_payload->>'targetCorrectionEventId'=$2
            LIMIT 1`,
          [roomId, command.targetCorrectionEventId],
        );
        if ((alreadyUndone.rowCount ?? alreadyUndone.rows.length) > 0) targetNotFound();
        const intervening = await client.query(
          `SELECT 1
             FROM analytics_review_detail d
             JOIN room_event e ON e.event_id=d.review_event_id AND e.room_id=d.room_id
            WHERE d.room_id=$1 AND d.change_kind='correction' AND e.room_seq>$2
            LIMIT 1`,
          [roomId, priorRoomSeq],
        );
        if ((intervening.rowCount ?? intervening.rows.length) > 0) targetNotFound();
        const nodes = await snapshotNodes();
        if (!nodes.has(payload.targetCanonicalNodeId)
          || nodes.has(payload.replacement.aliasNodeId)) targetNotFound();
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
        actorId: teacher.teacherId,
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
        [randomUUID(), event.eventId, roomId, changeKind, command, teacher.teacherId],
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
    } catch (error) {
      if (error instanceof RoomError && error.code === "ROOM_DELETION_IN_PROGRESS") {
        throw new AnalyticsTeacherError(410, "ROOM_DELETION_IN_PROGRESS");
      }
      throw error;
    }
    const replay = await this.pool.query<{ job_id: string }>(
      "SELECT job_id FROM worker_job WHERE dedupe_key=$1",
      [replayIdentity(roomId, "analytics_review", reviewEventId).dedupeKey],
    );
    const accepted = analyticsTeacherHttpContract.parseAccepted({
      schemaVersion: 1,
      reviewEventId,
      changeKind,
      replayJobId: replay.rows[0]?.job_id ?? replayJobId,
    });
    return { ...accepted, created };
  }

  async reviewDetail(
    principal: AuthSession | null, sessionId: string | undefined,
    roomId: string, reviewEventId: string,
  ): Promise<AnalyticsReviewDetail> {
    await this.requireTeacher(principal, sessionId, roomId);
    uuid(reviewEventId, "INVALID_ANALYTICS_QUERY");
    return inTransaction(this.pool, async (tx) => {
      await lockRoomInTransaction(tx, roomId);
      await this.assertNotDeleting(tx, roomId);
      await this.assertRetentionCurrent(tx, roomId);
      const result = await tx.query<{
        review_event_id: string; room_id: string; change_kind: "review" | "correction";
        validated_payload: unknown; created_at: Date;
      }>(
        `SELECT review_event_id,room_id,change_kind,validated_payload,created_at
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
      return analyticsTeacherHttpContract.parseDetail({
        schemaVersion: 1,
        reviewEventId: row.review_event_id,
        roomId: row.room_id,
        changeKind: row.change_kind,
        payload,
        createdAt: row.created_at.toISOString(),
      });
    });
  }

  private async assertNotDeleting(client: PoolClient, roomId: string): Promise<void> {
    const deletion = await client.query(
      `SELECT 1 FROM deletion_job
        WHERE room_id=$1 AND status IN ('queued','running','retryable','dead')
        LIMIT 1`,
      [roomId],
    );
    if (deletion.rowCount === 1) {
      throw new AnalyticsTeacherError(410, "ROOM_DELETION_IN_PROGRESS");
    }
  }

  private async assertRetentionCurrent(client: PoolClient, roomId: string): Promise<void> {
    const retention = await client.query<{ policy_current: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM classroom_room r
           JOIN pilot_retention_policy p ON p.policy_id=r.retention_policy_id
          WHERE r.room_id=$1
            AND p.approved_at <= transaction_timestamp()
            AND p.expires_at > transaction_timestamp()
       ) AS policy_current`,
      [roomId],
    );
    const policyCurrent = retention.rows[0]?.policy_current;
    if (typeof policyCurrent !== "boolean") {
      throw new AnalyticsTeacherError(503, "ANALYTICS_CORRUPT");
    }
    if (!policyCurrent) {
      throw new AnalyticsTeacherError(410, "RETENTION_POLICY_EXPIRED");
    }
  }

  private async requireTeacher(
    principal: AuthSession | null,
    sessionId: string | undefined,
    roomId: string,
  ): Promise<Extract<AuthSession, { role: "teacher" }>> {
    if (!principal) throw new AnalyticsPolicyError(401, "AUTH_REQUIRED");
    if (principal.role !== "teacher") throw new AnalyticsPolicyError(404, "ROOM_NOT_FOUND");
    uuid(roomId);
    const grant = await this.policy.requireRoomAccess(principal, roomId, "latest", sessionId);
    if (grant.role !== "teacher") throw new AnalyticsPolicyError(404, "ROOM_NOT_FOUND");
    return principal;
  }
}
