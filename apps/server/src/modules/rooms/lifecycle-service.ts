import { randomUUID } from "node:crypto";

import type { RoomEventEnvelope } from "@learning-orbit/contracts";
import type { Clock } from "../../clock.js";
import { RoomError } from "./errors.js";
import type {
  RoomEventRepository,
  RoomEventTransactionContext,
  RoomEventDraft,
} from "./room-event-repository.js";

const ROOM_DURATION_MS = 45 * 60 * 1_000;

type ManualEventType =
  | "room.opened"
  | "room.paused"
  | "room.resumed"
  | "room.closed";

function validNow(clock: Clock): Date {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("INVALID_CLOCK");
  }
  return new Date(now);
}

function assertManualRetry(
  event: RoomEventEnvelope,
  expectedType: ManualEventType,
  roomId: string,
  teacherId: string,
): RoomEventEnvelope {
  if (
    event.roomId !== roomId
    || event.type !== expectedType
    || event.actorId !== teacherId
    || event.actorKind !== "human"
    || event.actorRole !== "teacher"
    || event.revision !== 1
    || event.operation !== "add"
  ) throw new RoomError("INVALID_COMMAND");
  return event;
}

async function existingManualRetry(
  context: RoomEventTransactionContext,
  causationId: string,
  expectedType: ManualEventType,
  roomId: string,
  teacherId: string,
): Promise<RoomEventEnvelope | null> {
  const existing = await context.findByCausation(causationId);
  return existing
    ? assertManualRetry(existing, expectedType, roomId, teacherId)
    : null;
}

export async function revokeStudentSessions(
  context: RoomEventTransactionContext,
  roomId: string,
  now: Date,
): Promise<void> {
  await context.client.query(
    `UPDATE auth_session AS session SET revoked_at = $2
     FROM room_member AS member
     WHERE session.room_member_id = member.room_member_id
       AND member.room_id = $1
       AND session.revoked_at IS NULL`,
    [roomId, now],
  );
}

export async function cancelRoomJobs(
  context: RoomEventTransactionContext,
  roomId: string,
  now: Date,
  preserveJobId?: string,
): Promise<void> {
  await context.client.query(
    `UPDATE worker_job
     SET status = 'cancelled', claim_token = NULL, locked_at = NULL,
         locked_by = NULL, updated_at = $2
     WHERE room_id = $1
       AND status IN ('queued', 'retryable', 'running')
       AND ($3::uuid IS NULL OR job_id <> $3::uuid)`,
    [roomId, now, preserveJobId ?? null],
  );
}

export async function appendAutomaticClose(
  context: RoomEventTransactionContext,
  roomId: string,
  jobId: string,
  closesAt: Date,
  clock: Clock,
  correlationId: RoomEventDraft["correlationId"] = randomUUID(),
  preserveJobId?: string,
): Promise<RoomEventEnvelope> {
  const now = validNow(clock);
  await context.client.query(
    `UPDATE classroom_room SET status = 'closed', closed_at = $2 WHERE room_id = $1`,
    [roomId, closesAt],
  );
  await revokeStudentSessions(context, roomId, now);
  await cancelRoomJobs(context, roomId, now, preserveJobId);
  return context.append({
    type: "room.closed",
    actorId: jobId,
    actorKind: "system",
    actorRole: "room_clock",
    revision: 1,
    operation: "add",
    eventTime: closesAt,
    causationId: jobId,
    correlationId,
    payload: { closedAt: closesAt.toISOString() },
  });
}

export class RoomLifecycleService {
  constructor(
    readonly events: RoomEventRepository,
    readonly clock: Clock,
  ) {}

  async open(
    roomId: string,
    teacherId: string,
    causationId: string,
    sessionId?: string,
  ): Promise<RoomEventEnvelope> {
    return this.events.transact(roomId, async (context) => {
      this.#requireOwner(context, teacherId);
      await this.#assertTeacherSession(context, teacherId, sessionId);
      const retry = await existingManualRetry(
        context,
        causationId,
        "room.opened",
        roomId,
        teacherId,
      );
      if (retry) return retry;
      if (context.room.status !== "scheduled") throw new RoomError("INVALID_COMMAND");

      const now = validNow(this.clock);
      const closesAt = new Date(now.getTime() + ROOM_DURATION_MS);
      await context.client.query(
        `UPDATE classroom_room
         SET status = 'open', starts_at = $2, closes_at = $3
         WHERE room_id = $1`,
        [roomId, now, closesAt],
      );
      const event = await context.append({
        type: "room.opened",
        actorId: teacherId,
        actorKind: "human",
        actorRole: "teacher",
        revision: 1,
        operation: "add",
        eventTime: now,
        causationId,
        correlationId: randomUUID(),
        payload: {
          startsAt: now.toISOString(),
          closesAt: closesAt.toISOString(),
        },
      });
      try {
        await context.client.query(
          `INSERT INTO worker_job(
             job_type, room_id, source_event_id, dedupe_key,
             correlation_id, payload, run_after
           ) VALUES($1, $2, $3, $4, $5, $6, $7)`,
          [
            "room.auto-close.v1",
            roomId,
            event.eventId,
            `room.auto-close.v1:${roomId}`,
            event.correlationId,
            { roomId, closesAt: closesAt.toISOString() },
            closesAt,
          ],
        );
      } catch {
        throw new Error("ROOM_AUTO_CLOSE_ENQUEUE_FAILED");
      }
      return event;
    });
  }

  async pause(
    roomId: string,
    teacherId: string,
    causationId: string,
    sessionId?: string,
  ): Promise<RoomEventEnvelope> {
    const retry = await this.#ownerRetry(roomId, teacherId, causationId, "room.paused", sessionId);
    if (retry) return retry;
    if (await this.closeIfDueForOwner(roomId, teacherId, sessionId)) throw new RoomError("ROOM_NOT_OPEN");
    return this.#simpleTransition(
      roomId,
      teacherId,
      causationId,
      "room.paused",
      "open",
      "paused",
      "pausedAt",
      sessionId,
    );
  }

  async resume(
    roomId: string,
    teacherId: string,
    causationId: string,
    sessionId?: string,
  ): Promise<RoomEventEnvelope> {
    const retry = await this.#ownerRetry(roomId, teacherId, causationId, "room.resumed", sessionId);
    if (retry) return retry;
    if (await this.closeIfDueForOwner(roomId, teacherId, sessionId)) throw new RoomError("ROOM_NOT_OPEN");
    return this.#simpleTransition(
      roomId,
      teacherId,
      causationId,
      "room.resumed",
      "paused",
      "open",
      "resumedAt",
      sessionId,
    );
  }

  async close(
    roomId: string,
    teacherId: string,
    causationId: string,
    sessionId?: string,
  ): Promise<RoomEventEnvelope> {
    const retry = await this.#ownerRetry(roomId, teacherId, causationId, "room.closed", sessionId);
    if (retry) return retry;
    if (await this.closeIfDueForOwner(roomId, teacherId, sessionId)) throw new RoomError("ROOM_NOT_OPEN");
    return this.events.transact(roomId, async (context) => {
      this.#requireOwner(context, teacherId);
      await this.#assertTeacherSession(context, teacherId, sessionId);
      const retry = await existingManualRetry(
        context,
        causationId,
        "room.closed",
        roomId,
        teacherId,
      );
      if (retry) return retry;
      if (context.room.status !== "open" && context.room.status !== "paused") {
        throw new RoomError("ROOM_NOT_OPEN");
      }

      const now = validNow(this.clock);
      await context.client.query(
        `UPDATE classroom_room
         SET status = 'closed', closed_at = $2
         WHERE room_id = $1`,
        [roomId, now],
      );
      await revokeStudentSessions(context, roomId, now);
      await cancelRoomJobs(context, roomId, now);
      return context.append({
        type: "room.closed",
        actorId: teacherId,
        actorKind: "human",
        actorRole: "teacher",
        revision: 1,
        operation: "add",
        eventTime: now,
        causationId,
        correlationId: randomUUID(),
        payload: { closedAt: now.toISOString() },
      });
    });
  }

  /** Idempotently converge an expired open/paused room using its canonical auto-close job. */
  async closeIfDue(roomId: string): Promise<RoomEventEnvelope | null> {
    return this.events.transact(roomId, async (context) => this.#closeDueInContext(context));
  }

  async closeIfDueForOwner(roomId: string, teacherId: string, sessionId?: string): Promise<RoomEventEnvelope | null> {
    return this.events.transact(roomId, async (context) => { this.#requireOwner(context, teacherId); await this.#assertTeacherSession(context, teacherId, sessionId); return this.#closeDueInContext(context); });
  }

  async #ownerRetry(roomId: string, teacherId: string, causationId: string, type: ManualEventType, sessionId?: string): Promise<RoomEventEnvelope | null> {
    return this.events.transact(roomId, async (context) => { this.#requireOwner(context, teacherId); await this.#assertTeacherSession(context, teacherId, sessionId); return existingManualRetry(context, causationId, type, roomId, teacherId); });
  }

  async #closeDueInContext(
    context: RoomEventTransactionContext,
  ): Promise<RoomEventEnvelope | null> {
    if ((context.room.status !== "open" && context.room.status !== "paused") || !context.room.closes_at) return null;
    const closesAt = new Date(context.room.closes_at);
    const now = validNow(this.clock);
    if (!Number.isFinite(closesAt.getTime()) || closesAt.getTime() > now.getTime()) return null;
    const job = await context.client.query<{ job_id: string; correlation_id: string; source_event_id: string | null; dedupe_key: string; run_after: Date; status: string; payload: Record<string, unknown> }>(
      `SELECT j.job_id, j.correlation_id, j.source_event_id, j.dedupe_key,
              j.run_after, j.status, j.payload
       FROM worker_job j
       WHERE j.room_id = $1 AND j.job_type = 'room.auto-close.v1'
       ORDER BY j.created_at, j.job_id LIMIT 1 FOR UPDATE`,
      [context.room.room_id],
    );
    const candidate = job.rows[0];
    if (!candidate) return null;
    const source = candidate.source_event_id ? await context.client.query<{ room_id: string; type: string; actor_kind: string; actor_role: string; revision: number; operation: string; correlation_id: string; payload: Record<string, unknown> }>(
      "SELECT room_id, type, actor_kind, actor_role, revision, operation, correlation_id, payload FROM room_event WHERE event_id = $1", [candidate.source_event_id],
    ) : { rows: [] };
    const sourceRow = source.rows[0];
    const jobId = candidate.job_id;
    const expectedPayload = candidate.payload;
    if (candidate.status !== "queued" && candidate.status !== "running") return null;
    if (candidate.dedupe_key !== `room.auto-close.v1:${context.room.room_id}`
      || candidate.run_after.toISOString() !== closesAt.toISOString()
      || expectedPayload?.roomId !== context.room.room_id || expectedPayload?.closesAt !== closesAt.toISOString()
      || sourceRow?.room_id !== context.room.room_id || sourceRow.type !== "room.opened"
      || sourceRow.actor_kind !== "human" || sourceRow.actor_role !== "teacher"
      || sourceRow.revision !== 1 || sourceRow.operation !== "add"
      || sourceRow.correlation_id !== candidate.correlation_id
      || sourceRow.payload?.closesAt !== closesAt.toISOString()) return null;
    const correlationId = candidate.correlation_id as RoomEventDraft["correlationId"];
    return appendAutomaticClose(context, context.room.room_id, jobId, closesAt, this.clock, correlationId);
  }

  async #simpleTransition(
    roomId: string,
    teacherId: string,
    causationId: string,
    eventType: "room.paused" | "room.resumed",
    requiredStatus: "open" | "paused",
    nextStatus: "open" | "paused",
    payloadKey: "pausedAt" | "resumedAt",
    sessionId?: string,
  ): Promise<RoomEventEnvelope> {
    return this.events.transact(roomId, async (context) => {
      this.#requireOwner(context, teacherId);
      await this.#assertTeacherSession(context, teacherId, sessionId);
      const retry = await existingManualRetry(
        context,
        causationId,
        eventType,
        roomId,
        teacherId,
      );
      if (retry) return retry;
      if (context.room.status !== requiredStatus) throw new RoomError("ROOM_NOT_OPEN");

      const now = validNow(this.clock);
      await context.client.query(
        "UPDATE classroom_room SET status = $2 WHERE room_id = $1",
        [roomId, nextStatus],
      );
      return context.append({
        type: eventType,
        actorId: teacherId,
        actorKind: "human",
        actorRole: "teacher",
        revision: 1,
        operation: "add",
        eventTime: now,
        causationId,
        correlationId: randomUUID(),
        payload: { [payloadKey]: now.toISOString() },
      });
    });
  }

  #requireOwner(context: RoomEventTransactionContext, teacherId: string): void {
    if (context.room.teacher_id !== teacherId) throw new RoomError("FORBIDDEN");
  }

  async #assertTeacherSession(
    context: RoomEventTransactionContext,
    teacherId: string,
    sessionId?: string,
  ): Promise<void> {
    if (!sessionId) return;
    const result = await context.client.query(
      `SELECT 1 FROM auth_session
       WHERE session_id = $1 AND principal_kind = 'teacher'
         AND teacher_id = $2 AND revoked_at IS NULL
         AND expires_at > transaction_timestamp()`,
      [sessionId, teacherId],
    );
    if (result.rowCount !== 1) throw new RoomError("FORBIDDEN");
  }
}
