import { createHash, randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type { Clock } from "../../clock.js";
import { inTransaction } from "../../db/transactions.js";
import { lockRoomInTransaction } from "../rooms/room-lock.js";

export interface AgentReconcileResult {
  readonly failed: number;
  readonly cancelled: number;
}

/** States from which a run may still be reconciled to a terminal one. */
const ACTIVE_STATES = "('queued','running','streaming')";

interface OrphanRun {
  agent_run_id: string;
  room_id: string;
  state: string;
  reason: "job_dead" | "job_cancelled" | "room_not_open";
}

/**
 * Give a run that can no longer finish a terminal state.
 *
 * An agent_run is advanced to `completed` by the worker's own callback, and to
 * `cancelled` by a teacher. Nothing owned the two ways a run stops without
 * either happening: the job exhausted its attempts and went dead, or the room
 * closed underneath it. In both cases the run stayed `running` for good.
 *
 * That is not only untidy. `one_active_agent_run_per_room` is a partial unique
 * index over exactly these states, so a single abandoned run permanently blocks
 * every future run in that room, and the teacher console goes on showing Nova
 * as thinking about a session that ended.
 */
export class AgentRunReconciler {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
    private readonly batchSize: number = 50,
  ) {}

  async #orphans(): Promise<OrphanRun[]> {
    const result = await this.pool.query<OrphanRun>(
      `SELECT r.agent_run_id, r.room_id, r.state::text AS state,
              CASE
                WHEN c.status = 'closed' THEN 'room_not_open'
                WHEN j.status = 'dead' THEN 'job_dead'
                ELSE 'job_cancelled'
              END AS reason
       FROM agent_run r
       JOIN classroom_room c ON c.room_id = r.room_id
       LEFT JOIN worker_job j ON j.dedupe_key = 'agent.execute.v1:' || r.agent_run_id::text
       WHERE r.state::text IN ${ACTIVE_STATES}
         AND (
           c.status = 'closed'
           OR j.status IN ('dead','cancelled')
           OR j.job_id IS NULL
         )
       ORDER BY r.created_at ASC
       LIMIT $1`,
      [this.batchSize],
    );
    return result.rows;
  }

  async reconcile(): Promise<AgentReconcileResult> {
    let failed = 0;
    let cancelled = 0;

    for (const orphan of await this.#orphans()) {
      const settled = await inTransaction(this.pool, async (tx) => {
        await lockRoomInTransaction(tx, orphan.room_id);
        // Re-read under the lock: the worker may have completed the run
        // between selection and here, and a completed run is never reopened.
        const fresh = await tx.query<{ state: string }>(
          `SELECT state::text AS state FROM agent_run WHERE agent_run_id = $1 FOR UPDATE`,
          [orphan.agent_run_id],
        );
        const state = fresh.rows[0]?.state;
        if (!state || !["queued", "running", "streaming"].includes(state)) return null;

        // A run whose job died genuinely failed; one the room outlived, or a
        // teacher cancelled, did not. The distinction is what a teacher reads.
        const terminal = orphan.reason === "job_dead" ? "failed" : "cancelled";
        const reasonCode = orphan.reason === "job_dead"
          ? "AGENT_EXECUTION_EXHAUSTED"
          : orphan.reason === "room_not_open" ? "ROOM_NOT_OPEN" : "AGENT_RUN_CANCELLED";
        await tx.query(
          `UPDATE agent_run
           SET state = $2::agent_run_state, failure_code = $3, updated_at = $4
           WHERE agent_run_id = $1`,
          [orphan.agent_run_id, terminal, reasonCode, this.clock.now()],
        );
        await tx.query(
          `INSERT INTO agent_run_transition(transition_id, agent_run_id, from_state, to_state,
                                            reason_code, causation_id, transitioned_at)
           VALUES($1,$2,$3::agent_run_state,$4::agent_run_state,$5,$6,$7)
           ON CONFLICT (causation_id) DO NOTHING`,
          [randomUUID(), orphan.agent_run_id, state, terminal, reasonCode,
            reconcileCausation(orphan.agent_run_id, terminal), this.clock.now()],
        );
        return terminal;
      });

      if (settled === "failed") failed += 1;
      else if (settled === "cancelled") cancelled += 1;
    }

    return { failed, cancelled };
  }
}

/**
 * One stable causation per run and outcome, so a repeated sweep records the
 * same fact once rather than a transition per pass.
 */
function reconcileCausation(agentRunId: string, terminal: string): string {
  const digest = createHash("sha1")
    .update(`agent-run-reconcile:${agentRunId}:${terminal}`)
    .digest("hex");
  const variant = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}
