import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCoreEventPayloadRegistry } from "@learning-orbit/contracts";

import { runMigrations } from "../../src/db/migrate.js";
import { AgentRunReconciler } from "../../src/modules/agent/agent-run-reconciler.js";
import { RoomEventRepository } from "../../src/modules/rooms/room-event-repository.js";
import { RoomLifecycleService } from "../../src/modules/rooms/lifecycle-service.js";
import { resetBusinessTables } from "../db/reset.js";
import {
  lifecycleDatabaseUrl,
  MutableClock,
  seedLifecycleRoom,
  type SeededLifecycleRoom,
} from "../rooms/lifecycle-test-fixture.js";

const pool = new Pool({ connectionString: lifecycleDatabaseUrl, max: 8 });
let clock: MutableClock;

async function openRoom(): Promise<SeededLifecycleRoom> {
  const room = await seedLifecycleRoom(pool);
  await new RoomLifecycleService(
    new RoomEventRepository(pool, createCoreEventPayloadRegistry(), clock), clock,
  ).open(room.roomId, room.teacherId, randomUUID());
  return room;
}

/** An active run with the execute job the worker would have created. */
async function activeRun(room: SeededLifecycleRoom, jobStatus: string | null) {
  const trigger = (await pool.query<{ event_id: string }>(
    "SELECT event_id FROM room_event WHERE room_id = $1 ORDER BY room_seq LIMIT 1", [room.roomId],
  )).rows[0]!.event_id;
  const agentRunId = randomUUID();
  await pool.query(
    `INSERT INTO agent_run(agent_run_id, room_id, state, trigger_event_id,
                           requested_by_room_member_id, input_from_room_seq,
                           input_through_room_seq, correlation_id, model_provider,
                           model_id, prompt_version, policy_version)
     VALUES($1,$2,'running',$3,$4,1,1,$5,'fixture','fixture-model','v1','v1')`,
    [agentRunId, room.roomId, trigger, room.memberIds[0], randomUUID()],
  );
  if (jobStatus) {
    // A running job must carry its lease, or the row itself is invalid.
    const leased = jobStatus === "running";
    await pool.query(
      `INSERT INTO worker_job(job_id, job_type, room_id, source_event_id, dedupe_key,
                              correlation_id, payload, run_after, status,
                              claim_token, locked_at, locked_by)
       VALUES($1,'agent.execute.v1',$2,$3,$4,$5,$6, now(), $7, $8, $9, $10)`,
      [randomUUID(), room.roomId, trigger, `agent.execute.v1:${agentRunId}`,
        randomUUID(), { agentRunId }, jobStatus,
        leased ? randomUUID() : null, leased ? new Date() : null, leased ? "worker-a" : null],
    );
  }
  return agentRunId;
}

const runState = async (agentRunId: string) => (await pool.query<{
  state: string; failure_code: string | null;
}>(
  "SELECT state::text AS state, failure_code FROM agent_run WHERE agent_run_id = $1", [agentRunId],
)).rows[0];

const transitions = async (agentRunId: string) => (await pool.query<{ to_state: string; reason_code: string }>(
  "SELECT to_state::text AS to_state, reason_code FROM agent_run_transition WHERE agent_run_id = $1",
  [agentRunId],
)).rows;

beforeAll(async () => runMigrations(lifecycleDatabaseUrl!, "infra/postgres/migrations"));
beforeEach(async () => {
  await resetBusinessTables(lifecycleDatabaseUrl!);
  clock = new MutableClock("2026-08-30T08:00:00.000Z");
});
afterAll(async () => pool.end());

describe("agent run reconciliation", () => {
  it("leaves a run alone while its job can still succeed", async () => {
    const room = await openRoom();
    const agentRunId = await activeRun(room, "running");

    expect(await new AgentRunReconciler(pool, clock).reconcile())
      .toEqual({ failed: 0, cancelled: 0 });
    expect(await runState(agentRunId)).toMatchObject({ state: "running" });
  });

  it("fails a run whose job exhausted its attempts", async () => {
    const room = await openRoom();
    const agentRunId = await activeRun(room, "dead");

    expect(await new AgentRunReconciler(pool, clock).reconcile())
      .toEqual({ failed: 1, cancelled: 0 });
    expect(await runState(agentRunId))
      .toEqual({ state: "failed", failure_code: "AGENT_EXECUTION_EXHAUSTED" });
    expect(await transitions(agentRunId))
      .toEqual([{ to_state: "failed", reason_code: "AGENT_EXECUTION_EXHAUSTED" }]);
  });

  it("cancels rather than fails a run the room outlived", async () => {
    const room = await openRoom();
    const agentRunId = await activeRun(room, "running");
    await pool.query("UPDATE classroom_room SET status = 'closed', closed_at = now() WHERE room_id = $1", [room.roomId]);

    expect(await new AgentRunReconciler(pool, clock).reconcile())
      .toEqual({ failed: 0, cancelled: 1 });
    // A session that ended is not a failed answer, and a teacher reads the
    // difference.
    expect(await runState(agentRunId))
      .toEqual({ state: "cancelled", failure_code: "ROOM_NOT_OPEN" });
  });

  it("cancels a run whose job was cancelled or never existed", async () => {
    // Two separate rooms: one active run per room is a database invariant.
    const withCancelledJob = await activeRun(await openRoom(), "cancelled");
    const withNoJob = await activeRun(await openRoom(), null);

    expect(await new AgentRunReconciler(pool, clock).reconcile())
      .toEqual({ failed: 0, cancelled: 2 });
    expect((await runState(withCancelledJob))?.state).toBe("cancelled");
    // A run whose job vanished entirely cannot finish either.
    expect((await runState(withNoJob))?.state).toBe("cancelled");
  });

  it("never reopens a run the worker already completed", async () => {
    const room = await openRoom();
    const agentRunId = await activeRun(room, "dead");
    await pool.query("UPDATE agent_run SET state = 'completed' WHERE agent_run_id = $1", [agentRunId]);

    expect(await new AgentRunReconciler(pool, clock).reconcile())
      .toEqual({ failed: 0, cancelled: 0 });
    expect((await runState(agentRunId))?.state).toBe("completed");
  });

  it("records the same fact once however often it sweeps", async () => {
    const room = await openRoom();
    const agentRunId = await activeRun(room, "dead");
    const reconciler = new AgentRunReconciler(pool, clock);

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(await transitions(agentRunId)).toHaveLength(1);
  });

  it("unblocks the room for a future run", async () => {
    const room = await openRoom();
    await activeRun(room, "dead");
    await new AgentRunReconciler(pool, clock).reconcile();

    // one_active_agent_run_per_room is a partial unique index over exactly the
    // active states, so an abandoned run blocks the room permanently. A second
    // run also needs its own trigger event, which one_agent_run_per_trigger
    // enforces separately.
    const events = new RoomEventRepository(pool, createCoreEventPayloadRegistry(), clock);
    const nextTrigger = await events.transact(room.roomId, async (context) => context.append({
      type: "message.added",
      actorId: room.memberIds[1],
      actorKind: "human",
      actorRole: "student",
      revision: 1,
      operation: "add",
      eventTime: clock.now(),
      causationId: randomUUID(),
      correlationId: randomUUID(),
      payload: { messageId: randomUUID(), text: "再問一次", replyTo: null, mentions: [], mediaIds: [] },
    }));
    const trigger = nextTrigger.eventId;
    await expect(pool.query(
      `INSERT INTO agent_run(agent_run_id, room_id, state, trigger_event_id,
                             requested_by_room_member_id, input_from_room_seq,
                             input_through_room_seq, correlation_id, model_provider,
                             model_id, prompt_version, policy_version)
       VALUES($1,$2,'queued',$3,$4,1,1,$5,'fixture','fixture-model','v1','v1')`,
      [randomUUID(), room.roomId, trigger, room.memberIds[1], randomUUID()],
    )).resolves.toBeTruthy();
  });
});
