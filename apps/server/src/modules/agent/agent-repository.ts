import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { agentContract, type AgentCurrentState, type AgentRun, type AgentSettingsResponse } from "@learning-orbit/contracts";
import type { Clock } from "../../clock.js";
import { inTransaction } from "../../db/transactions.js";
import { lockRoomInTransaction } from "../rooms/room-lock.js";

export type AgentRunOwner = Readonly<{ teacherId: string | null; roomMemberId: string | null; actorId: string; role: "teacher" | "student" }>;
export type AgentRunRequest = Readonly<{
  roomId: string;
  triggerEventId: string;
  owner: AgentRunOwner;
  sessionId?: string;
  beforeCreate?: (tx: PoolClient) => Promise<void>;
}>;
export type AgentRunCreation = Readonly<{ run: AgentRun; created: boolean }>;

type RunRow = {
  agent_run_id: string; room_id: string; state: AgentRun["state"]; trigger_event_id: string;
  requested_by_actor_id: string; requested_by_role: AgentRun["requestedByRole"];
  input_from_room_seq: string; input_through_room_seq: string; model_provider: string; model_id: string;
  prompt_version: string; policy_version: string; failure_code: string | null; created_at: Date; updated_at: Date;
};

function asRun(row: RunRow): AgentRun {
  return agentContract.parseRun({
    agentRunId: row.agent_run_id, roomId: row.room_id, state: row.state,
    triggerEventId: row.trigger_event_id, requestedByActorId: row.requested_by_actor_id,
    requestedByRole: row.requested_by_role, inputFromRoomSeq: Number(row.input_from_room_seq),
    inputThroughRoomSeq: Number(row.input_through_room_seq), modelProvider: row.model_provider,
    modelId: row.model_id, promptVersion: row.prompt_version, policyVersion: row.policy_version,
    failureCode: row.failure_code, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  });
}

const runColumns = `agent_run_id, room_id, state, trigger_event_id,
  COALESCE(requested_by_teacher_id, requested_by_room_member_id) AS requested_by_actor_id,
  CASE WHEN requested_by_teacher_id IS NULL THEN 'student' ELSE 'teacher' END AS requested_by_role,
  input_from_room_seq, input_through_room_seq, model_provider, model_id,
  prompt_version, policy_version, failure_code, created_at, updated_at`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class AgentRepository {
  constructor(private readonly pool: Pool, private readonly clock: Clock) {}

  private async requireActiveSession(
    tx: PoolClient,
    roomId: string,
    owner: AgentRunOwner,
    sessionId: string | undefined,
  ): Promise<void> {
    if (!sessionId) return;
    if (!UUID.test(sessionId)) throw new Error("ROOM_NOT_FOUND");
    const active = owner.role === "teacher"
      ? await tx.query(
        `SELECT 1 FROM auth_session s
         JOIN classroom_room r ON r.teacher_id=s.teacher_id
         WHERE s.session_id=$1 AND r.room_id=$2 AND s.teacher_id=$3
           AND s.principal_kind='teacher' AND s.revoked_at IS NULL
           AND s.expires_at > transaction_timestamp()
         FOR SHARE OF s`,
        [sessionId, roomId, owner.teacherId],
      )
      : await tx.query(
        `SELECT 1 FROM auth_session s
         JOIN room_member m ON m.room_member_id=s.room_member_id
         WHERE s.session_id=$1 AND m.room_id=$2 AND m.room_member_id=$3
           AND m.actor_id=$4 AND s.principal_kind='student'
           AND s.revoked_at IS NULL AND s.expires_at > transaction_timestamp()
         FOR SHARE OF s`,
        [sessionId, roomId, owner.roomMemberId, owner.actorId],
      );
    if (active.rowCount !== 1) throw new Error("ROOM_NOT_FOUND");
  }

  async getOrCreateRunAndJob(input: AgentRunRequest, retryTriggerConflict = true): Promise<AgentRunCreation> {
    return inTransaction(this.pool, async (tx) => {
      await lockRoomInTransaction(tx, input.roomId);
      const room = await tx.query<{ status: string; agent_enabled: boolean; nova_actor_id: string }>(
        `SELECT status, agent_enabled, nova_actor_id FROM classroom_room
         WHERE room_id = $1 FOR UPDATE`,
        [input.roomId],
      );
      const lockedRoom = room.rows[0];
      if (!lockedRoom) throw new Error("ROOM_NOT_FOUND");
      await this.requireActiveSession(tx, input.roomId, input.owner, input.sessionId);
      const existing = await tx.query<RunRow>(`SELECT ${runColumns} FROM agent_run WHERE room_id = $1 AND trigger_event_id = $2 FOR UPDATE`, [input.roomId, input.triggerEventId]);
      if (existing.rowCount === 1) return { run: asRun(existing.rows[0]!), created: false };
      if (lockedRoom.status !== "open") throw new Error("ROOM_NOT_OPEN");
      if (!lockedRoom.agent_enabled) throw new Error("AGENT_DISABLED");
      const trigger = await tx.query<{
        room_seq: string;
        correlation_id: string;
        actor_kind: string;
        type: string;
        operation: string;
        payload: { messageId?: unknown };
      }>(
        `SELECT room_seq, correlation_id, actor_kind, type, operation, payload
         FROM room_event WHERE room_id = $1 AND event_id = $2`,
        [input.roomId, input.triggerEventId],
      );
      if (trigger.rowCount !== 1) throw new Error("TRIGGER_EVENT_NOT_FOUND");
      const triggerRow = trigger.rows[0]!;
      if (triggerRow.actor_kind === "agent") throw new Error("AGENT_CANNOT_TRIGGER_AGENT");
      if (!["message.added", "message.revised"].includes(triggerRow.type)
        || triggerRow.operation === "retract"
        || typeof triggerRow.payload?.messageId !== "string"
        || !UUID.test(triggerRow.payload.messageId)) {
        throw new Error("TRIGGER_EVENT_NOT_ACTIVE");
      }
      const latest = await tx.query<{ room_seq: string; operation: string; payload: { mentions?: unknown } }>(
        `SELECT room_seq, operation, payload FROM room_event
         WHERE room_id = $1
           AND type IN ('message.added','message.revised','message.retracted')
           AND payload->>'messageId' = $2
         ORDER BY revision DESC, room_seq DESC LIMIT 1 FOR SHARE`,
        [input.roomId, triggerRow.payload.messageId],
      );
      const latestRow = latest.rows[0];
      if (!latestRow || latestRow.operation === "retract") throw new Error("TRIGGER_EVENT_NOT_ACTIVE");
      const latestMentions = Array.isArray(latestRow.payload?.mentions) ? latestRow.payload.mentions : [];
      if (input.owner.role !== "teacher" && !latestMentions.includes(lockedRoom.nova_actor_id)) {
        throw new Error("EXPLICIT_TRIGGER_REQUIRED");
      }
      const active = await tx.query(
        `SELECT agent_run_id FROM agent_run
         WHERE room_id = $1 AND state IN ('queued','running','streaming')
         ORDER BY created_at LIMIT 1 FOR UPDATE`,
        [input.roomId],
      );
      if (active.rowCount !== 0) throw new Error("AGENT_RUN_ALREADY_ACTIVE");
      await input.beforeCreate?.(tx);
      const agentRunId = randomUUID();
      const now = this.clock.now();
      const seq = Number(latestRow.room_seq);
      await tx.query(
        `INSERT INTO agent_run(agent_run_id, room_id, state, trigger_event_id,
          requested_by_teacher_id, requested_by_room_member_id, input_from_room_seq,
          input_through_room_seq, correlation_id, model_provider, model_id,
          prompt_version, policy_version, created_at, updated_at)
         VALUES ($1, $2, 'queued', $3, $4, $5, 1, $6, $7, 'fixture',
          'fixture-socratic-v1', 'socratic-facilitator-v1', 'socratic-policy-v1', $8, $8)`,
        [agentRunId, input.roomId, input.triggerEventId, input.owner.teacherId,
          input.owner.roomMemberId, seq, triggerRow.correlation_id, now],
      );
      await tx.query(
        `INSERT INTO worker_job(job_type, room_id, source_event_id, dedupe_key,
          correlation_id, payload, run_after)
         VALUES ('agent.execute.v1', $1, $2, $3, $4, $5, $6)`,
        [input.roomId, input.triggerEventId, `agent.execute.v1:${agentRunId}`,
          triggerRow.correlation_id, { agentRunId }, now],
      );
      await tx.query(
        `INSERT INTO agent_run_transition(transition_id, agent_run_id, from_state,
          to_state, reason_code, causation_id, transitioned_at)
         VALUES ($1, $2, NULL, 'queued', 'TRIGGERED', $3, $4)`,
        [randomUUID(), agentRunId, input.triggerEventId, now],
      );
      const created = await tx.query<RunRow>(`SELECT ${runColumns} FROM agent_run WHERE agent_run_id = $1`, [agentRunId]);
      return { run: asRun(created.rows[0]!), created: true };
    }).catch((error) => {
      if (retryTriggerConflict
        && (error as { code?: string }).code === "23505"
        && (error as { constraint?: string }).constraint === "one_agent_run_per_trigger") {
        return this.getOrCreateRunAndJob(input, false);
      }
      if ((error as { code?: string }).code === "23505" && (error as { constraint?: string }).constraint === "one_active_agent_run_per_room") throw new Error("AGENT_RUN_ALREADY_ACTIVE");
      throw error;
    });
  }

  async getCurrent(roomId: string, health: () => Promise<"healthy" | "degraded" | "unavailable">): Promise<AgentCurrentState> {
    const roomResult = await this.pool.query<{ agent_enabled: boolean }>("SELECT agent_enabled FROM classroom_room WHERE room_id = $1", [roomId]);
    const result = await this.pool.query<RunRow>(`SELECT ${runColumns} FROM agent_run WHERE room_id = $1 ORDER BY updated_at DESC LIMIT 1`, [roomId]);
    const row = result.rows[0];
    const serviceHealth = await health();
    const run = row?.agent_run_id ? asRun(row) : null;
    return agentContract.parseCurrent({ roomId, run: run ? { agentRunId: run.agentRunId, state: run.state, failureCode: run.failureCode, createdAt: run.createdAt, updatedAt: run.updatedAt } : null, serviceHealth, agentEnabled: roomResult.rows[0]?.agent_enabled ?? false, updatedAt: this.clock.now().toISOString() });
  }

  async cancelRun(roomId: string, runId: string, teacherId: string, causationId: string, sessionId?: string): Promise<AgentRun> {
    return inTransaction(this.pool, async (tx) => {
      await lockRoomInTransaction(tx, roomId);
      await this.requireActiveSession(tx, roomId, { role: "teacher", teacherId, roomMemberId: null, actorId: teacherId }, sessionId);
      const found = await tx.query<RunRow>(`SELECT ${runColumns} FROM agent_run WHERE agent_run_id = $1 AND room_id = $2 AND EXISTS (SELECT 1 FROM classroom_room WHERE room_id = $2 AND teacher_id = $3) FOR UPDATE`, [runId, roomId, teacherId]);
      if (found.rowCount !== 1) throw new Error("AGENT_RUN_NOT_FOUND");
      const run = asRun(found.rows[0]!);
      if (!["queued", "running", "streaming"].includes(run.state)) throw new Error("AGENT_RUN_NOT_ACTIVE");
      return this.cancelLocked(tx, run, causationId, "CANCEL_REQUESTED");
    });
  }

  async setEnabled(roomId: string, teacherId: string, enabled: boolean, causationId: string, sessionId?: string): Promise<AgentSettingsResponse> {
    return inTransaction(this.pool, async (tx) => {
      await lockRoomInTransaction(tx, roomId);
      await this.requireActiveSession(tx, roomId, { role: "teacher", teacherId, roomMemberId: null, actorId: teacherId }, sessionId);
      const room = await tx.query<{ agent_enabled: boolean }>(`SELECT agent_enabled FROM classroom_room WHERE room_id = $1 AND teacher_id = $2 FOR UPDATE`, [roomId, teacherId]);
      if (room.rowCount !== 1) throw new Error("ROOM_NOT_FOUND");
      await tx.query(`UPDATE classroom_room SET agent_enabled = $2 WHERE room_id = $1`, [roomId, enabled]);
      let cancelledRunId: string | null = null;
      if (!enabled) {
        const active = await tx.query<RunRow>(`SELECT ${runColumns} FROM agent_run WHERE room_id = $1 AND state IN ('queued','running','streaming') ORDER BY created_at LIMIT 1 FOR UPDATE`, [roomId]);
        if (active.rowCount === 1) {
          const cancelled = await this.cancelLocked(tx, asRun(active.rows[0]!), causationId, "AGENT_DISABLED");
          cancelledRunId = cancelled.agentRunId;
        }
      }
      await tx.query(`INSERT INTO agent_control_event(control_event_id, room_id, teacher_id, action, agent_run_id, causation_id, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (causation_id) DO NOTHING`, [randomUUID(), roomId, teacherId, enabled ? "enable" : "disable", cancelledRunId, causationId, this.clock.now()]);
      return agentContract.parseSettingsResponse({ enabled, cancelledRunId });
    });
  }

  private async cancelLocked(tx: PoolClient, run: AgentRun, causationId: string, reasonCode: string): Promise<AgentRun> {
    const now = this.clock.now();
    await tx.query(`UPDATE agent_run SET state = 'cancelled', failure_code = $2, updated_at = $3 WHERE agent_run_id = $1`, [run.agentRunId, reasonCode, now]);
    await tx.query(`UPDATE worker_job SET status = 'cancelled', cancel_requested_at = $2, claim_token = NULL, locked_at = NULL, locked_by = NULL, updated_at = $2 WHERE dedupe_key = $1`, [`agent.execute.v1:${run.agentRunId}`, now]);
    await tx.query(`INSERT INTO agent_run_transition(transition_id, agent_run_id, from_state, to_state, reason_code, causation_id, transitioned_at) VALUES ($1,$2,$3,'cancelled',$4,$5,$6) ON CONFLICT (causation_id) DO NOTHING`, [randomUUID(), run.agentRunId, run.state, reasonCode, causationId, now]);
    const result = await tx.query<RunRow>(`SELECT ${runColumns} FROM agent_run WHERE agent_run_id = $1`, [run.agentRunId]);
    return asRun(result.rows[0]!);
  }
}
