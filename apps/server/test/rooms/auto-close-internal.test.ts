import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createCoreEventPayloadRegistry,
  roomInternalAutoCloseContract,
  routes,
  type RoomInternalAutoCloseRequest,
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
} from "./lifecycle-test-fixture.js";

const pool = new Pool({ connectionString: lifecycleDatabaseUrl, max: 16 });
const issuer = new ServiceAssertionFixtureIssuer();
const trust = createServiceAssertionTrust({
  version: 1,
  keys: [{
    issuer: issuer.issuer,
    keyId: issuer.keyId,
    publicKeyPem: issuer.publicKeyPem,
  }],
});
const apps: FastifyInstance[] = [];
let clock: MutableClock;
let lifecycle: RoomLifecycleService;

function makeLifecycle(): RoomLifecycleService {
  return new RoomLifecycleService(
    new RoomEventRepository(pool, createCoreEventPayloadRegistry(), clock),
    clock,
  );
}

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

function requestFor(claim: ClaimedJob, closesAt: string): RoomInternalAutoCloseRequest {
  const identity = claimIdentity(claim);
  if (!identity.roomId || !identity.sourceEventId) throw new Error("EXPECTED_ROOM_JOB_CLAIM");
  return roomInternalAutoCloseContract.parseRequest({
    ...identity,
    roomId: identity.roomId,
    sourceEventId: identity.sourceEventId,
    closesAt,
  });
}

function assertionFor(body: RoomInternalAutoCloseRequest): string {
  return issuer.sign({
    subject: body.workerId,
    audience: "internal.rooms.autoClose",
    body,
    now: clock.now(),
  }).raw;
}

async function post(
  app: FastifyInstance,
  body: RoomInternalAutoCloseRequest,
  assertion = assertionFor(body),
) {
  const response = await app.inject({
    method: "POST",
    url: routes.internal.rooms.autoClose(),
    headers: { "x-lo-service-assertion": assertion },
    payload: body,
  });
  return {
    statusCode: response.statusCode,
    body: roomInternalAutoCloseContract.parseResponse(response.json()),
  };
}

async function openedClaim(
  room: SeededLifecycleRoom,
  workerId = "worker-room-clock-1",
): Promise<{ claim: ClaimedJob; request: RoomInternalAutoCloseRequest }> {
  const opened = await lifecycle.open(room.roomId, room.teacherId, randomUUID());
  const closesAt = opened.payload.closesAt;
  if (typeof closesAt !== "string") throw new Error("EXPECTED_CLOSES_AT");
  const claims = await new JobStore(pool, workerId).claim(1);
  expect(claims).toHaveLength(1);
  const claim = claims[0]!;
  return { claim, request: requestFor(claim, closesAt) };
}

beforeAll(async () => runMigrations(lifecycleDatabaseUrl, "infra/postgres/migrations"));
beforeEach(async () => {
  await resetBusinessTables(lifecycleDatabaseUrl);
  clock = new MutableClock("2026-08-30T08:00:00.000Z");
  lifecycle = makeLifecycle();
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await pool.query(
    "ALTER TABLE room_event DROP CONSTRAINT IF EXISTS auto_close_internal_test_reject",
  );
  await resetBusinessTables(lifecycleDatabaseUrl);
});
afterAll(async () => pool.end());

describe("signed internal room auto-close", () => {
  it("returns a content-free 500 for unexpected internal failures", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, request } = await openedClaim(room);
    const app = await makeApp();
    await pool.query(
      `ALTER TABLE room_event
       ADD CONSTRAINT auto_close_internal_test_reject CHECK (type <> 'room.closed')`,
    );
    clock.set("2026-08-30T08:45:00.000Z");

    const response = await app.inject({
      method: "POST",
      url: routes.internal.rooms.autoClose(),
      headers: {
        "x-lo-service-assertion": assertionFor(request),
      },
      payload: request,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "INTERNAL" });
    expect(response.body).not.toContain("ROOM_EVENT_APPEND_FAILED");
    expect(response.body).not.toContain(claim.jobId);
    expect((await pool.query(
      "SELECT status FROM classroom_room WHERE room_id = $1",
      [room.roomId],
    )).rows[0]).toEqual({ status: "open" });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM worker_job_completion WHERE job_id = $1",
      [claim.jobId],
    )).rows[0]).toEqual({ count: 0 });
  });

  it.each(["null", "[]", '"bad"', "{}"]) ("rejects malformed source payload %s", async (json) => {
    const room = await seedLifecycleRoom(pool);
    const { claim, request } = await openedClaim(room);
    const app = await makeApp();
    await pool.query(`UPDATE room_event SET payload = '${json}'::jsonb WHERE event_id = $1`, [request.sourceEventId]);
    clock.set("2026-08-30T08:45:00.000Z");
    expect(await post(app, request)).toEqual({ statusCode: 409, body: { status: "rejected", code: "JOB_FAMILY_IDENTITY_INVALID" } });
    expect((await pool.query("SELECT count(*)::int AS count FROM room_event WHERE room_id = $1", [room.roomId])).rows[0]).toEqual({ count: 1 });
    await app.close();
  });
  it("keeps not-due work unmarked, closes once, preserves its claim, and recovers after marker loss", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, request } = await openedClaim(room);
    const app = await makeApp();

    clock.set("2026-08-30T08:30:00.000Z");
    expect(await post(app, request)).toEqual({
      statusCode: 200,
      body: { status: "retryable", code: "ROOM_CLOSE_NOT_DUE" },
    });
    expect((await pool.query(
      "SELECT 1 FROM worker_job_completion WHERE job_id = $1",
      [claim.jobId],
    )).rowCount).toBe(0);

    await pool.query(
      `INSERT INTO worker_job(job_type, room_id, dedupe_key, payload)
       VALUES('probe.other.v1', $1, $2, '{}')`,
      [room.roomId, `other:${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO worker_job(
         job_type, room_id, dedupe_key, payload, status,
         claim_generation, claim_token, locked_at, locked_by
       ) VALUES('probe.running.v1', $1, $2, '{}', 'running', 1, $3, now(), 'worker-other')`,
      [room.roomId, `running:${randomUUID()}`, randomUUID()],
    );

    clock.set("2026-08-30T08:45:00.000Z");
    expect(await post(app, request)).toEqual({
      statusCode: 200,
      body: { status: "completed", code: "ROOM_CLOSED" },
    });
    clock.set("2026-08-30T08:45:10.000Z");
    expect(await post(app, request)).toEqual({
      statusCode: 200,
      body: { status: "completed", code: "ALREADY_CLOSED" },
    });

    const closeEvents = await pool.query<{
      actor_id: string;
      actor_kind: string;
      actor_role: string;
      causation_id: string;
      event_time: Date;
      payload: Record<string, unknown>;
    }>(
      `SELECT actor_id, actor_kind, actor_role, causation_id, event_time, payload
       FROM room_event
       WHERE room_id = $1 AND type = 'room.closed'`,
      [room.roomId],
    );
    expect(closeEvents.rows).toEqual([{
      actor_id: claim.jobId,
      actor_kind: "system",
      actor_role: "room_clock",
      causation_id: claim.jobId,
      event_time: new Date(request.closesAt),
      payload: { closedAt: request.closesAt },
    }]);
    const sessions = await pool.query<{ revoked: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked FROM auth_session
       WHERE room_member_id = ANY($1::uuid[])`,
      [room.memberIds],
    );
    expect(sessions.rows.every(({ revoked }) => revoked)).toBe(true);
    const jobs = await pool.query<{
      job_id: string;
      status: string;
      claim_token: string | null;
      locked_by: string | null;
    }>(
      "SELECT job_id, status, claim_token, locked_by FROM worker_job WHERE room_id = $1",
      [room.roomId],
    );
    expect(jobs.rows.find(({ job_id }) => job_id === claim.jobId)).toMatchObject({
      status: "running",
      claim_token: claim.claimToken,
      locked_by: claim.workerId,
    });
    expect(jobs.rows.filter(({ job_id }) => job_id !== claim.jobId).every((job) => (
      job.status === "cancelled" && job.claim_token === null && job.locked_by === null
    ))).toBe(true);
    expect((await pool.query(
      "SELECT 1 FROM worker_job_completion WHERE job_id = $1",
      [claim.jobId],
    )).rowCount).toBe(1);

    await pool.query(
      `UPDATE worker_job
       SET locked_at = now() - interval '3 minutes', attempts = max_attempts
       WHERE job_id = $1`,
      [claim.jobId],
    );
    expect(await new JobStore(pool, "worker-recovery").claim(10)).toEqual([]);
    expect((await pool.query(
      "SELECT status FROM worker_job WHERE job_id = $1",
      [claim.jobId],
    )).rows[0]).toEqual({ status: "succeeded" });
    expect((await pool.query(
      "SELECT 1 FROM worker_job_completion WHERE job_id = $1",
      [claim.jobId],
    )).rowCount).toBe(0);
    expect(closeEvents.rowCount).toBe(1);
  });

  it("rejects forged, overflow, family-mismatched, raw-payload, and stale claims without closing", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, request } = await openedClaim(room);
    const app = await makeApp();
    clock.set("2026-08-30T08:45:00.000Z");

    expect(await post(app, request, "not-an-assertion")).toEqual({
      statusCode: 401,
      body: { status: "rejected", code: "SERVICE_ASSERTION_INVALID" },
    });
    const wrongDedupe = roomInternalAutoCloseContract.parseRequest({
      ...request,
      dedupeKey: `room.auto-close.v1:${randomUUID()}`,
    });
    expect(await post(app, wrongDedupe)).toEqual({
      statusCode: 409,
      body: { status: "rejected", code: "JOB_FAMILY_IDENTITY_INVALID" },
    });
    const overflow = roomInternalAutoCloseContract.parseRequest({
      ...request,
      claimGeneration: "9223372036854775808",
    });
    expect(await post(app, overflow)).toEqual({
      statusCode: 409,
      body: { status: "rejected", code: "JOB_FAMILY_IDENTITY_INVALID" },
    });
    const wrongCorrelation = roomInternalAutoCloseContract.parseRequest({
      ...request,
      correlationId: randomUUID(),
    });
    expect(await post(app, wrongCorrelation)).toEqual({
      statusCode: 409,
      body: { status: "rejected", code: "JOB_FAMILY_IDENTITY_INVALID" },
    });

    await pool.query(
      "UPDATE worker_job SET payload = $2 WHERE job_id = $1",
      [claim.jobId, { roomId: room.roomId, closesAt: "2026-08-30T08:44:59.000Z" }],
    );
    expect(await post(app, request)).toEqual({
      statusCode: 409,
      body: { status: "rejected", code: "JOB_FAMILY_IDENTITY_INVALID" },
    });
    await pool.query(
      "UPDATE worker_job SET payload = $2, locked_at = now() - interval '3 minutes' WHERE job_id = $1",
      [claim.jobId, { roomId: room.roomId, closesAt: request.closesAt }],
    );
    expect((await new JobStore(pool, "worker-new").claim(1))).toHaveLength(1);
    expect(await post(app, request)).toEqual({
      statusCode: 409,
      body: { status: "rejected", code: "JOB_CLAIM_STALE" },
    });

    expect((await pool.query(
      "SELECT count(*)::int AS count FROM room_event WHERE room_id = $1 AND type = 'room.closed'",
      [room.roomId],
    )).rows[0]).toEqual({ count: 0 });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM worker_job_completion WHERE job_id = $1",
      [claim.jobId],
    )).rows[0]).toEqual({ count: 0 });
  });

  it("serializes a manual-close race with auto-close and never creates two close events", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, request } = await openedClaim(room);
    const app = await makeApp();
    clock.set("2026-08-30T08:45:00.000Z");

    const [manual, automatic] = await Promise.allSettled([
      lifecycle.close(room.roomId, room.teacherId, randomUUID()),
      post(app, request),
    ]);
    expect(automatic.status).toBe("fulfilled");
    if (automatic.status === "fulfilled") {
      expect([
        { statusCode: 200, body: { status: "completed", code: "ROOM_CLOSED" } },
        { statusCode: 409, body: { status: "rejected", code: "JOB_CLAIM_STALE" } },
      ]).toContainEqual(automatic.value);
    }
    expect(["fulfilled", "rejected"]).toContain(manual.status);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM room_event WHERE room_id = $1 AND type = 'room.closed'",
      [room.roomId],
    )).rows[0]).toEqual({ count: 1 });
    expect((await pool.query(
      "SELECT status FROM classroom_room WHERE room_id = $1",
      [room.roomId],
    )).rows[0]).toEqual({ status: "closed" });
    const job = (await pool.query<{
      status: string;
      claim_token: string | null;
    }>(
      "SELECT status, claim_token FROM worker_job WHERE job_id = $1",
      [claim.jobId],
    )).rows[0];
    expect([
      { status: "cancelled", claim_token: null },
      { status: "running", claim_token: claim.claimToken },
    ]).toContainEqual(job);
  });
});
