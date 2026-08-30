import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  deletionLifecycleContract,
  type AuthSession,
  type DeletionStatus,
  type DeleteRoomRequest,
} from "@learning-orbit/contracts";
import { inTransaction } from "../../db/transactions.js";
import { lockRoomInTransaction } from "../rooms/room-lock.js";
import { makeDeletionReceipt } from "./retention-policy.js";

const SURFACES = ["events", "media", "derivatives", "artifacts", "projections", "agent_runs", "caches", "provider_copies"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DELETION_NAMESPACE = Buffer.from("4d3f1a0e6b9c42d8a1f0e5c7b2d64980", "hex");

export class GovernanceError extends Error {
  constructor(readonly code: "AUTH_REQUIRED" | "ROOM_NOT_FOUND" | "DELETION_IN_PROGRESS" | "DELETION_STATUS_CORRUPT" | "INVALID_DELETE_REQUEST" | "INVALID_EXPORT_FORMAT" | "EXPORT_UNAVAILABLE", readonly statusCode: 400 | 401 | 404 | 409 | 410 | 503 = 400) {
    super(code);
  }
}

function teacherOnly(principal: AuthSession | null): asserts principal is Extract<AuthSession, { role: "teacher" }> {
  if (!principal) throw new GovernanceError("AUTH_REQUIRED", 401);
  if (principal.role !== "teacher") throw new GovernanceError("ROOM_NOT_FOUND", 404);
}

function refHash(roomId: string, salt: string): string {
  return createHash("sha256").update(`${salt}:room:${roomId}`).digest("hex");
}

function stableUuid(parts: readonly string[]): string {
  const digest = createHash("sha1").update(DELETION_NAMESPACE).update(parts.join("\0")).digest();
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function freezeDeletionSurfaces(tx: PoolClient, deletionJobId: string, roomId: string, frozenAt: Date): Promise<void> {
  const countQueries: Record<typeof SURFACES[number], string> = {
    events: "SELECT count(*)::text AS count FROM room_event WHERE room_id=$1",
    media: "SELECT count(*)::text AS count FROM media_asset WHERE room_id=$1",
    derivatives: "SELECT count(*)::text AS count FROM media_derivative d JOIN media_asset m ON m.media_id=d.media_id WHERE m.room_id=$1",
    artifacts: "SELECT count(*)::text AS count FROM derived_text_artifact WHERE room_id=$1",
    projections: "SELECT (SELECT count(*) FROM analysis_projection_snapshots WHERE room_id=$1)+(SELECT count(*) FROM analysis_projection_patches WHERE room_id=$1)+(SELECT count(*) FROM analysis_projection_outbox WHERE room_id=$1) AS count",
    agent_runs: "SELECT count(*)::text AS count FROM agent_run WHERE room_id=$1",
    caches: "SELECT 0::text AS count",
    provider_copies: "SELECT 0::text AS count",
  };
  for (const surface of SURFACES) {
    // Capability-owned surfaces intentionally use a parameterless literal
    // probe.  Do not pass `roomId` to those statements: node-postgres rejects
    // an argument list whose length does not match the SQL placeholders, and
    // a failed probe would roll back the entire deletion request.
    const result = await tx.query<{ count: string }>(
      countQueries[surface],
      surface === "caches" || surface === "provider_copies" ? [] : [roomId],
    );
    const count = Number(result.rows[0]?.count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) throw new GovernanceError("DELETION_IN_PROGRESS", 409);
    await tx.query(
      `INSERT INTO deletion_surface_manifest(deletion_job_id,surface,expected_item_count,status,frozen_at)
       VALUES($1,$2,$3,'frozen',$4)`, [deletionJobId, surface, count, frozenAt],
    );
  }
}

async function enqueueDeletionSurfaceJobs(
  tx: PoolClient,
  deletionJobId: string,
  correlationId: string,
): Promise<void> {
  for (const surface of SURFACES) {
    const dedupeKey = `room.delete-surface.v1:${deletionJobId}:${surface}`;
    await tx.query(
      `INSERT INTO worker_job(job_id,job_type,room_id,source_event_id,dedupe_key,correlation_id,payload)
       VALUES($1,'room.delete-surface.v1',NULL,NULL,$2,$3,$4)
       ON CONFLICT(dedupe_key) DO NOTHING`,
      [stableUuid([deletionJobId, surface]), dedupeKey, correlationId, { deletionJobId, surface }],
    );
  }
}

function isSensitive(key: string): boolean {
  return /url|secret|token|cookie|authorization|api[-_]?key|provider|prompt|reasoning|transcript/i.test(key);
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isSensitive(key))
      .map(([key, child]) => [key, sanitize(child)]));
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}

export interface GovernanceServiceOptions {
  readonly auditSalt: string;
  readonly clock?: () => Date;
  /** Called only after the deletion transaction commits. */
  readonly evictRoom?: (roomId: string, code?: number) => void;
}

export class GovernanceService {
  private readonly clock: () => Date;
  constructor(private readonly pool: Pool, private readonly options: GovernanceServiceOptions) {
    if (!options.auditSalt || options.auditSalt.length < 16) throw new Error("AUDIT_SALT_REQUIRED");
    this.clock = options.clock ?? (() => new Date());
  }

  sanitizeExport(value: unknown): unknown { return sanitize(value); }

  async requestDeletion(principal: AuthSession | null, roomId: string, raw: unknown) {
    teacherOnly(principal);
    if (!UUID.test(roomId)) throw new GovernanceError("ROOM_NOT_FOUND", 404);
    let input: DeleteRoomRequest;
    try { input = deletionLifecycleContract.parseRequest(raw); }
    catch { throw new GovernanceError("INVALID_DELETE_REQUEST", 400); }
    if (input.confirmation !== `DELETE ${roomId}`) throw new GovernanceError("INVALID_DELETE_REQUEST", 400);
    const accepted = await inTransaction(this.pool, async (tx) => {
      await lockRoomInTransaction(tx, roomId);
      const room = await tx.query<{ room_id: string; teacher_id: string; status: string }>(
        "SELECT room_id, teacher_id, status FROM classroom_room WHERE room_id=$1 FOR UPDATE", [roomId]);
      if (room.rows[0]?.teacher_id !== principal.teacherId) throw new GovernanceError("ROOM_NOT_FOUND", 404);
      const existing = await tx.query<{ deletion_job_id: string }>(
        "SELECT deletion_job_id FROM deletion_job WHERE room_id=$1 AND owner_teacher_id=$2 AND status IN ('queued','running','retryable','dead') LIMIT 1 FOR UPDATE",
        [roomId, principal.teacherId]);
      if (existing.rows[0]) return { deletionJobId: existing.rows[0].deletion_job_id, status: "queued" as const };
      const deletionJobId = randomUUID();
      const correlationId = randomUUID();
      const inserted = await tx.query<{ deletion_job_id: string }>(
        `INSERT INTO deletion_job(deletion_job_id,correlation_id,room_id,room_ref_sha256,request_kind,status,owner_teacher_id,requested_by_teacher_id)
         VALUES($1,$2,$3,$4,'teacher','queued',$5,$5) RETURNING deletion_job_id`,
        [deletionJobId, correlationId, roomId, refHash(roomId, this.options.auditSalt), principal.teacherId]);
      await freezeDeletionSurfaces(tx, deletionJobId, roomId, this.clock());
      await tx.query("UPDATE classroom_room SET status='closed', closed_at=$2 WHERE room_id=$1", [roomId, this.clock()]);
      await tx.query("UPDATE auth_session SET revoked_at=$2 WHERE room_member_id IN (SELECT room_member_id FROM room_member WHERE room_id=$1) AND revoked_at IS NULL", [roomId, this.clock()]);
      await tx.query("UPDATE worker_job SET status='cancelled', claim_token=NULL, locked_at=NULL, locked_by=NULL WHERE room_id=$1 AND status IN ('queued','retryable','running')", [roomId]);
      // Lifecycle jobs deliberately carry a NULL room_id so the final delete
      // can remove classroom_room while the claim/receipt row remains alive.
      await enqueueDeletionSurfaceJobs(tx, deletionJobId, correlationId);
      await this.audit(tx, principal, roomId, correlationId, "deletion.request", "allowed", "DELETION_ACCEPTED");
      return deletionLifecycleContract.parseAccepted({ deletionJobId: inserted.rows[0]?.deletion_job_id ?? deletionJobId, status: "queued" });
    });
    // Session revocation and the closed-room tombstone are durable first;
    // eviction is a best-effort transport action and must never run before
    // that commit.  Every subsequent broadcast still reauthorizes against
    // the closed room, so a lost callback cannot reopen the surface.
    try { this.options.evictRoom?.(roomId, 4410); } catch { /* durable tombstone already won */ }
    return accepted;
  }

  async deletionStatus(principal: AuthSession | null, deletionJobId: string): Promise<DeletionStatus> {
    teacherOnly(principal);
    if (!UUID.test(deletionJobId)) throw new GovernanceError("ROOM_NOT_FOUND", 404);
    const result = await this.pool.query<any>(
      `SELECT deletion_job_id,status,completed_at,surfaces_verified FROM deletion_job j
       LEFT JOIN deletion_receipt r USING (deletion_job_id)
       WHERE j.deletion_job_id=$1 AND j.owner_teacher_id=$2`, [deletionJobId, principal.teacherId]);
    const row = result.rows[0];
    if (!row) throw new GovernanceError("ROOM_NOT_FOUND", 404);
    if (row.status === "completed") {
      const completed = row.completed_at === null || row.completed_at === undefined
        ? new Date(Number.NaN) : new Date(row.completed_at);
      if (!Number.isFinite(completed.getTime()) || row.surfaces_verified === null || row.surfaces_verified === undefined) {
        throw new GovernanceError("DELETION_STATUS_CORRUPT", 503);
      }
      try {
        const receipt = makeDeletionReceipt({ completedAt: completed.toISOString(), surfacesVerified: row.surfaces_verified });
        return deletionLifecycleContract.parseStatus({ deletionJobId, status: "completed", receipt });
      } catch {
        throw new GovernanceError("DELETION_STATUS_CORRUPT", 503);
      }
    }
    if (!["queued", "running", "retryable", "dead"].includes(row.status)) {
      throw new GovernanceError("DELETION_STATUS_CORRUPT", 503);
    }
    // Worker failure text is deliberately not part of deletion_job.  Read a
    // bounded, code-shaped value from the lifecycle jobs only; arbitrary
    // database text is treated as corruption rather than exposed to a client.
    let failureCode: string | null = null;
    if (row.status === "retryable" || row.status === "dead") {
      const failure = await this.pool.query<{ last_error: string | null }>(
        `SELECT last_error FROM worker_job
          WHERE job_type='room.delete-surface.v1'
            AND payload->>'deletionJobId'=$1
            AND last_error IS NOT NULL
          ORDER BY updated_at DESC,job_id DESC LIMIT 1`, [deletionJobId],
      );
      const candidate = failure.rows[0]?.last_error;
      if (candidate !== undefined && candidate !== null) {
        if (!/^[A-Z0-9_]{1,100}$/.test(candidate)) throw new GovernanceError("DELETION_STATUS_CORRUPT", 503);
        failureCode = candidate;
      }
    }
    return deletionLifecycleContract.parseStatus({
      deletionJobId, status: row.status,
      nextPollAfterMs: row.status === "dead" ? null : 1000,
      failureCode,
    });
  }

  async deletionStatusForRoom(principal: AuthSession | null, roomId: string): Promise<DeletionStatus> {
    teacherOnly(principal);
    if (!UUID.test(roomId)) throw new GovernanceError("ROOM_NOT_FOUND", 404);
    const result = await this.pool.query<{ deletion_job_id: string }>(
      "SELECT deletion_job_id FROM deletion_job WHERE room_ref_sha256=$1 AND owner_teacher_id=$2 ORDER BY created_at DESC LIMIT 1",
      [refHash(roomId, this.options.auditSalt), principal.teacherId],
    );
    if (!result.rows[0]) throw new GovernanceError("ROOM_NOT_FOUND", 404);
    return this.deletionStatus(principal, result.rows[0].deletion_job_id);
  }

  async exportRoom(principal: AuthSession | null, roomId: string, format: "json" | "csv") {
    teacherOnly(principal);
    if (!UUID.test(roomId)) throw new GovernanceError("ROOM_NOT_FOUND", 404);
    if (format !== "json" && format !== "csv") throw new GovernanceError("INVALID_EXPORT_FORMAT", 400);
    const rows = await inTransaction(this.pool, async (tx) => {
      const room = await tx.query<{ room_id: string }>(
        "SELECT room_id FROM classroom_room WHERE room_id=$1 AND teacher_id=$2 AND retention_policy_id IS NOT NULL", [roomId, principal.teacherId]);
      if (!room.rows[0]) throw new GovernanceError("ROOM_NOT_FOUND", 404);
      const events = await tx.query<any>(
        `SELECT event_id,room_id,room_seq,type,actor_id,actor_kind,actor_role,revision,operation,event_time,ingest_time,causation_id,correlation_id,payload
         FROM room_event WHERE room_id=$1 ORDER BY room_seq LIMIT 10000`, [roomId]);
      return events.rows.map((row) => ({
        eventId: row.event_id, roomId: row.room_id, roomSeq: Number(row.room_seq), type: row.type,
        actorId: row.actor_id, actorKind: row.actor_kind, actorRole: row.actor_role, revision: row.revision,
        operation: row.operation, eventTime: new Date(row.event_time).toISOString(), ingestTime: new Date(row.ingest_time).toISOString(),
        causationId: row.causation_id, correlationId: row.correlation_id, payload: sanitize(row.payload),
      }));
    });
    if (format === "json") return { filename: `learning-orbit-${roomId.slice(0, 8)}-export.json`, contentType: "application/json; charset=utf-8", body: JSON.stringify(rows) };
    const header = "eventId,roomSeq,type,actorId,actorKind,actorRole,revision,operation,eventTime,ingestTime\n";
    const body = rows.map((row) => [row.eventId, row.roomSeq, row.type, row.actorId, row.actorKind, row.actorRole, row.revision, row.operation, row.eventTime, row.ingestTime].map(csv).join(",")).join("\n");
    return { filename: `learning-orbit-${roomId.slice(0, 8)}-export.csv`, contentType: "text/csv; charset=utf-8", body: header + body + (body ? "\n" : "") };
  }

  private async audit(tx: PoolClient, principal: AuthSession, roomId: string, correlationId: string, action: string, outcome: string, reasonCode: string) {
    await tx.query(
      `INSERT INTO security_audit_event(security_audit_event_id,correlation_id,principal_kind,action,outcome,reason_code,room_ref_sha256)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), correlationId, principal.role, action, outcome, reasonCode, refHash(roomId, this.options.auditSalt)]);
  }
}

function csv(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
