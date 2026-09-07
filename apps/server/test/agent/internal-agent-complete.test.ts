import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  agentContract,
  createCoreEventPayloadRegistry,
  routes,
  type AgentInternalCommandRequest,
} from "@learning-orbit/contracts";

import { buildApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { JobStore, claimIdentity, type ClaimedJob } from "../../src/modules/jobs/job-store.js";
import { RoomEventRepository } from "../../src/modules/rooms/room-event-repository.js";
import { RoomLifecycleService } from "../../src/modules/rooms/lifecycle-service.js";
import { createServiceAssertionTrust } from "../../src/modules/security/service-assertion.js";
import { ServiceAssertionFixtureIssuer } from "../fixtures/service-assertion-issuer.js";
import { resetBusinessTables } from "../db/reset.js";
import {
  lifecycleDatabaseUrl,
  MutableClock,
  seedLifecycleRoom,
  type SeededLifecycleRoom,
} from "../rooms/lifecycle-test-fixture.js";

const pool = new Pool({ connectionString: lifecycleDatabaseUrl, max: 8 });
const issuer = new ServiceAssertionFixtureIssuer();
const trust = createServiceAssertionTrust({
  version: 1,
  keys: [{ issuer: issuer.issuer, keyId: issuer.keyId, publicKeyPem: issuer.publicKeyPem }],
});
const apps: FastifyInstance[] = [];
let clock: MutableClock;
let lifecycle: RoomLifecycleService;

const TEXT = "這一段推論裡，哪一步最需要更多證據？";

async function makeApp(): Promise<FastifyInstance> {
  const app = await buildApp({
    pool,
    clock,
    serviceAssertionTrust: trust,
    config: {
      allowedOrigins: ["https://app.learning-orbit.test"],
      publicBaseOrigin: "https://app.learning-orbit.test",
    },
  });
  apps.push(app);
  return app;
}

/** Open the room, append a student message, and queue one agent run against it. */
async function seedRunnableAgentJob(room: SeededLifecycleRoom): Promise<{
  claim: ClaimedJob;
  agentRunId: string;
  triggerEventId: string;
}> {
  const opened = await lifecycle.open(room.roomId, room.teacherId, randomUUID());
  const events = new RoomEventRepository(pool, createCoreEventPayloadRegistry(), clock);
  const trigger = await events.transact(room.roomId, async (context) => context.append({
    type: "message.added",
    actorId: room.memberIds[0],
    actorKind: "human",
    actorRole: "student",
    revision: 1,
    operation: "add",
    eventTime: clock.now(),
    causationId: randomUUID(),
    correlationId: opened.correlationId,
    payload: {
      messageId: randomUUID(),
      text: "光合作用需要什麼？",
      replyTo: null,
      mentions: [],
      mediaIds: [],
    },
  }));

  const agentRunId = randomUUID();
  const correlationId = randomUUID();
  await pool.query(
    `INSERT INTO agent_run(agent_run_id, room_id, state, trigger_event_id,
                           requested_by_room_member_id, input_from_room_seq,
                           input_through_room_seq, correlation_id, model_provider,
                           model_id, prompt_version, policy_version)
     VALUES($1,$2,'running',$3,$4,1,$5,$6,'fixture','fixture-model','v1','v1')`,
    [agentRunId, room.roomId, trigger.eventId, room.memberIds[0], trigger.roomSeq, correlationId],
  );
  await pool.query(
    `INSERT INTO worker_job(job_id, job_type, room_id, source_event_id, dedupe_key,
                            correlation_id, payload, run_after)
     VALUES($1,'agent.execute.v1',$2,$3,$4,$5,$6, now())`,
    [randomUUID(), room.roomId, trigger.eventId, `agent.execute.v1:${agentRunId}`,
      correlationId, { agentRunId }],
  );

  const claims = await new JobStore(pool, "worker-agent-1").claim(5);
  const claim = claims.find(({ jobType }) => jobType === "agent.execute.v1");
  if (!claim) throw new Error("EXPECTED_AGENT_JOB_CLAIM");
  return { claim, agentRunId, triggerEventId: trigger.eventId };
}

function requestFor(claim: ClaimedJob, agentRunId: string, overrides: Record<string, unknown> = {}) {
  const identity = claimIdentity(claim);
  return {
    ...identity,
    agentRunId,
    text: TEXT,
    outputSha256: createHash("sha256").update(TEXT, "utf8").digest("hex"),
    sourceEventIds: [identity.sourceEventId],
    warningCodes: [],
    ...overrides,
  } as AgentInternalCommandRequest;
}

async function post(app: FastifyInstance, body: AgentInternalCommandRequest, assertion?: string) {
  const response = await app.inject({
    method: "POST",
    url: routes.internal.agent.complete(),
    headers: {
      "x-lo-service-assertion": assertion ?? issuer.sign({
        subject: body.workerId,
        audience: "internal.agent.complete",
        body,
        now: clock.now(),
      }).raw,
    },
    payload: body,
  });
  return { statusCode: response.statusCode, body: agentContract.parseInternalResponse(response.json()) };
}

beforeAll(async () => runMigrations(lifecycleDatabaseUrl!, "infra/postgres/migrations"));
beforeEach(async () => {
  await resetBusinessTables(lifecycleDatabaseUrl!);
  clock = new MutableClock("2026-08-30T08:00:00.000Z");
  lifecycle = new RoomLifecycleService(
    new RoomEventRepository(pool, createCoreEventPayloadRegistry(), clock),
    clock,
  );
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await resetBusinessTables(lifecycleDatabaseUrl!);
});
afterAll(async () => pool.end());

describe("signed internal agent completion", () => {
  it("turns a worker result into one Nova message and a completed run", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, agentRunId } = await seedRunnableAgentJob(room);
    const app = await makeApp();

    const applied = await post(app, requestFor(claim, agentRunId));
    expect(applied.statusCode).toBe(200);
    expect(applied.body.status).toBe("applied");

    const event = await pool.query<{
      type: string; actor_kind: string; actor_role: string; actor_id: string; payload: Record<string, unknown>;
    }>(
      `SELECT type, actor_kind, actor_role, actor_id, payload FROM room_event
       WHERE room_id = $1 AND actor_kind = 'agent'`,
      [room.roomId],
    );
    expect(event.rowCount).toBe(1);
    expect(event.rows[0]).toMatchObject({
      type: "message.added",
      actor_kind: "agent",
      actor_role: "socratic_facilitator",
      actor_id: room.novaActorId,
    });
    expect(event.rows[0]!.payload).toMatchObject({ text: TEXT, agentRunId });

    expect((await pool.query("SELECT state FROM agent_run WHERE agent_run_id = $1", [agentRunId])).rows[0])
      .toEqual({ state: "completed" });
    expect((await pool.query(
      "SELECT to_state, reason_code FROM agent_run_transition WHERE agent_run_id = $1", [agentRunId],
    )).rows).toEqual([{ to_state: "completed", reason_code: "AGENT_EXECUTION_TERMINAL" }]);
  });

  it("answers a redelivered result with the event it already wrote", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, agentRunId } = await seedRunnableAgentJob(room);
    const app = await makeApp();
    const request = requestFor(claim, agentRunId);

    const first = await post(app, request);
    const second = await post(app, request);

    expect(first.body.status).toBe("applied");
    expect(second.body).toEqual({
      status: "already_applied",
      eventId: first.body.status === "applied" ? first.body.eventId : "",
    });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM room_event WHERE room_id = $1 AND actor_kind = 'agent'",
      [room.roomId],
    )).rows[0]).toEqual({ count: 1 });
  });

  it("refuses text whose digest the server cannot reproduce", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, agentRunId } = await seedRunnableAgentJob(room);
    const app = await makeApp();

    const response = await post(app, requestFor(claim, agentRunId, {
      outputSha256: createHash("sha256").update("something else", "utf8").digest("hex"),
    }));

    expect(response).toEqual({
      statusCode: 409,
      body: { status: "rejected", code: "AGENT_OUTPUT_INVALID" },
    });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM room_event WHERE room_id = $1 AND actor_kind = 'agent'",
      [room.roomId],
    )).rows[0]).toEqual({ count: 0 });
  });

  it("writes nothing for a superseded claim", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, agentRunId } = await seedRunnableAgentJob(room);
    const app = await makeApp();
    const stale = requestFor(claim, agentRunId);

    // A second worker reclaims the job; the first attempt's token is now old.
    await pool.query(
      `UPDATE worker_job SET claim_generation = claim_generation + 1, claim_token = $2
       WHERE job_id = $1`,
      [claim.jobId, randomUUID()],
    );

    expect(await post(app, stale)).toEqual({
      statusCode: 409,
      body: { status: "rejected", code: "JOB_CLAIM_STALE" },
    });
    expect((await pool.query(
      "SELECT state FROM agent_run WHERE agent_run_id = $1", [agentRunId],
    )).rows[0]).toEqual({ state: "running" });
  });

  it("refuses any browser Origin, allowed or not, before the route runs", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, agentRunId } = await seedRunnableAgentJob(room);
    const app = await makeApp();
    const body = requestFor(claim, agentRunId);
    const assertion = issuer.sign({
      subject: body.workerId,
      audience: "internal.agent.complete",
      body,
      now: clock.now(),
    }).raw;

    for (const origin of ["https://app.learning-orbit.test", "https://wrong.example"]) {
      const response = await app.inject({
        method: "POST",
        url: routes.internal.agent.complete(),
        headers: { "x-lo-service-assertion": assertion, origin },
        payload: body,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ code: "ORIGIN_FORBIDDEN" });
    }
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM room_event WHERE room_id = $1 AND actor_kind = 'agent'",
      [room.roomId],
    )).rows[0]).toEqual({ count: 0 });
  });

  it("rejects an unsigned request without touching room state", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, agentRunId } = await seedRunnableAgentJob(room);
    const app = await makeApp();

    const response = await post(app, requestFor(claim, agentRunId), "not-a-signature");

    expect(response).toEqual({
      statusCode: 401,
      body: { status: "rejected", code: "SERVICE_ASSERTION_INVALID" },
    });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM room_event WHERE room_id = $1 AND actor_kind = 'agent'",
      [room.roomId],
    )).rows[0]).toEqual({ count: 0 });
  });

  it("refuses a run that is no longer active", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, agentRunId } = await seedRunnableAgentJob(room);
    const app = await makeApp();
    await pool.query("UPDATE agent_run SET state = 'cancelled' WHERE agent_run_id = $1", [agentRunId]);

    expect(await post(app, requestFor(claim, agentRunId))).toEqual({
      statusCode: 409,
      body: { status: "rejected", code: "AGENT_RUN_NOT_ACTIVE" },
    });
  });
});
