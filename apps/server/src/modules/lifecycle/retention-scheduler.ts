import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type { Clock } from "../../clock.js";
import { inTransaction } from "../../db/transactions.js";
import {
  enqueueDeletionSurfaceJobs,
  freezeDeletionSurfaces,
  refHash,
} from "../governance/governance-service.js";
import { lockRoomInTransaction } from "../rooms/room-lock.js";

export interface RetentionSweepResult {
  readonly scheduled: readonly string[];
  readonly alreadyScheduled: number;
}

const DEFAULT_BATCH = 20;

/**
 * Expire rooms whose retention window has run out.
 *
 * Retention is the half of the privacy promise nobody presses a button for: a
 * teacher deletes the rooms they remember, and every other room has to expire
 * on its own. Without this, "we keep classroom data for N days" is a sentence
 * in a policy document with nothing enforcing it.
 *
 * It deliberately reuses the teacher deletion saga rather than running a
 * parallel one. Freezing the same surface manifest and enqueuing the same
 * dependency-ordered jobs means an expired room is deleted by the code that is
 * already proven, and a teacher who deletes a room the scheduler is also
 * expiring converges on the single job the partial unique index allows.
 */
export class RetentionScheduler {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
    private readonly auditSalt: string,
    private readonly batchSize: number = DEFAULT_BATCH,
  ) {}

  /**
   * Rooms whose longest-lived surface is now past its policy window.
   *
   * `room_events_days` bounds the room: the schema already requires it to be
   * at least as long as every derived surface, so a room past it is past all
   * of them.
   */
  async #expired(): Promise<Array<{ room_id: string; policy_version: string; teacher_id: string }>> {
    const result = await this.pool.query<{ room_id: string; policy_version: string; teacher_id: string }>(
      `SELECT r.room_id, p.policy_version, r.teacher_id
       FROM classroom_room r
       JOIN pilot_retention_policy p ON p.policy_id = r.retention_policy_id
       WHERE r.status = 'closed'
         AND r.closed_at IS NOT NULL
         AND r.closed_at + make_interval(days => p.room_events_days) <= $1
         AND NOT EXISTS (
           SELECT 1 FROM deletion_job d
           WHERE d.room_id = r.room_id
             AND d.status IN ('queued','running','retryable','dead')
         )
       ORDER BY r.closed_at ASC
       LIMIT $2`,
      [this.clock.now(), this.batchSize],
    );
    return result.rows;
  }

  async sweep(): Promise<RetentionSweepResult> {
    const scheduled: string[] = [];
    let alreadyScheduled = 0;

    for (const room of await this.#expired()) {
      const started = await inTransaction(this.pool, async (tx) => {
        await lockRoomInTransaction(tx, room.room_id);
        // Re-read under the lock: a teacher may have requested deletion of the
        // same room between selection and here, and there may only be one saga.
        const existing = await tx.query<{ deletion_job_id: string }>(
          `SELECT deletion_job_id FROM deletion_job
           WHERE room_id = $1 AND status IN ('queued','running','retryable','dead')
           LIMIT 1 FOR UPDATE`,
          [room.room_id],
        );
        if (existing.rows[0]) return null;

        const deletionJobId = randomUUID();
        const correlationId = randomUUID();
        await tx.query(
          `INSERT INTO deletion_job(deletion_job_id, correlation_id, room_id, room_ref_sha256,
                                    request_kind, policy_version, status, owner_teacher_id,
                                    requested_by_teacher_id)
           VALUES($1,$2,$3,$4,'retention',$5,'queued',$6,NULL)`,
          [deletionJobId, correlationId, room.room_id, refHash(room.room_id, this.auditSalt),
            room.policy_version, room.teacher_id],
        );
        await freezeDeletionSurfaces(tx, deletionJobId, room.room_id, this.clock.now());
        await tx.query(
          `UPDATE auth_session SET revoked_at = $2
           WHERE room_member_id IN (SELECT room_member_id FROM room_member WHERE room_id = $1)
             AND revoked_at IS NULL`,
          [room.room_id, this.clock.now()],
        );
        await tx.query(
          `UPDATE worker_job SET status = 'cancelled', claim_token = NULL,
                  locked_at = NULL, locked_by = NULL
           WHERE room_id = $1 AND status IN ('queued','retryable','running')`,
          [room.room_id],
        );
        await enqueueDeletionSurfaceJobs(tx, deletionJobId, correlationId);
        // The audit row names the policy that expired the room, never the room.
        await tx.query(
          `INSERT INTO security_audit_event(security_audit_event_id, correlation_id,
                                            principal_kind, action, outcome, reason_code,
                                            room_ref_sha256)
           VALUES($1,$2,'service','deletion.request','allowed','RETENTION_EXPIRED',$3)`,
          [randomUUID(), correlationId, refHash(room.room_id, this.auditSalt)],
        );
        return deletionJobId;
      });

      if (started) scheduled.push(started);
      else alreadyScheduled += 1;
    }

    return { scheduled, alreadyScheduled };
  }
}
