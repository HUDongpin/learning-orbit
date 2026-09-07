import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCoreEventPayloadRegistry } from "@learning-orbit/contracts";

import { runMigrations } from "../../src/db/migrate.js";
import { GovernanceService } from "../../src/modules/governance/governance-service.js";
import { RetentionScheduler } from "../../src/modules/lifecycle/retention-scheduler.js";
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
const POLICY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac";
const POLICY_VERSION = "retention-expiry-fixture";
const SALT = "retention-salt-at-least-sixteen-characters";
const RETENTION_DAYS = 30;
let clock: MutableClock;

async function installPolicy() {
  await pool.query(
    `INSERT INTO pilot_retention_policy(policy_id, policy_version, room_events_days, raw_media_days,
       derived_artifacts_days, projections_days, agent_runs_days, provider_copies_days,
       backups_days, audit_metadata_days, approval_reference, approved_at, expires_at)
     VALUES($1,$2,$3,14,7,7,7,7,90,365,'test',now(),now() + interval '365 days')
     ON CONFLICT (policy_version) DO NOTHING`,
    [POLICY_ID, POLICY_VERSION, RETENTION_DAYS],
  );
}

/** A room closed `daysAgo` days ago under the fixture policy. */
async function closedRoom(daysAgo: number): Promise<SeededLifecycleRoom> {
  const room = await seedLifecycleRoom(pool);
  await new RoomLifecycleService(
    new RoomEventRepository(pool, createCoreEventPayloadRegistry(), clock), clock,
  ).open(room.roomId, room.teacherId, randomUUID());
  await pool.query(
    `UPDATE classroom_room
     SET status = 'closed', closed_at = now() - make_interval(days => $2),
         retention_policy_id = $3
     WHERE room_id = $1`,
    [room.roomId, daysAgo, POLICY_ID],
  );
  return room;
}

const deletionJobs = async (roomId: string) => (await pool.query<{
  request_kind: string; policy_version: string | null; status: string;
}>(
  "SELECT request_kind, policy_version, status FROM deletion_job WHERE room_id = $1",
  [roomId],
)).rows;

beforeAll(async () => runMigrations(lifecycleDatabaseUrl!, "infra/postgres/migrations"));
beforeEach(async () => {
  await resetBusinessTables(lifecycleDatabaseUrl!);
  clock = new MutableClock(new Date().toISOString());
  await installPolicy();
});
afterEach(async () => {
  await resetBusinessTables(lifecycleDatabaseUrl!);
  await pool.query("DELETE FROM pilot_retention_policy WHERE policy_version = $1", [POLICY_VERSION]);
});
afterAll(async () => pool.end());

describe("retention expiry", () => {
  it("leaves a room inside its retention window alone", async () => {
    const room = await closedRoom(RETENTION_DAYS - 1);

    const result = await new RetentionScheduler(pool, clock, SALT).sweep();

    expect(result.scheduled).toEqual([]);
    expect(await deletionJobs(room.roomId)).toEqual([]);
  });

  it("expires a room once its window has run out, naming the policy that did it", async () => {
    const room = await closedRoom(RETENTION_DAYS + 1);

    const result = await new RetentionScheduler(pool, clock, SALT).sweep();

    expect(result.scheduled).toHaveLength(1);
    expect(await deletionJobs(room.roomId)).toEqual([
      { request_kind: "retention", policy_version: POLICY_VERSION, status: "queued" },
    ]);
    // The same saga as a teacher deletion: one frozen manifest, one job set.
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM deletion_surface_manifest WHERE deletion_job_id = $1",
      [result.scheduled[0]],
    )).rows[0]).toEqual({ count: 8 });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM worker_job WHERE job_type = 'room.delete-surface.v1'",
    )).rows[0]).toEqual({ count: 8 });
    // Seats lose access the moment the room is scheduled for expiry.
    expect((await pool.query(
      `SELECT count(*)::int AS count FROM auth_session s
       JOIN room_member m ON m.room_member_id = s.room_member_id
       WHERE m.room_id = $1 AND s.revoked_at IS NULL`,
      [room.roomId],
    )).rows[0]).toEqual({ count: 0 });
  });

  it("records the expiry without naming the room it expired", async () => {
    await closedRoom(RETENTION_DAYS + 1);

    await new RetentionScheduler(pool, clock, SALT).sweep();

    const audit = (await pool.query<{
      action: string; outcome: string; reason_code: string; principal_kind: string; room_ref_sha256: string;
    }>(
      "SELECT action, outcome, reason_code, principal_kind, room_ref_sha256 FROM security_audit_event",
    )).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "deletion.request",
      outcome: "allowed",
      reason_code: "RETENTION_EXPIRED",
      principal_kind: "service",
    });
    expect(audit[0]!.room_ref_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is safe to run twice and never starts a second saga", async () => {
    const room = await closedRoom(RETENTION_DAYS + 1);
    const scheduler = new RetentionScheduler(pool, clock, SALT);

    const first = await scheduler.sweep();
    const second = await scheduler.sweep();

    expect(first.scheduled).toHaveLength(1);
    // The second pass finds the job already there and selects nothing at all.
    expect(second.scheduled).toEqual([]);
    expect(await deletionJobs(room.roomId)).toHaveLength(1);
  });

  it("converges with a teacher who deletes the same room first", async () => {
    const room = await closedRoom(RETENTION_DAYS + 1);
    const governance = new GovernanceService(pool, {
      auditSalt: SALT,
      clock: () => clock.now(),
    });
    const accepted = await governance.requestDeletion(
      { role: "teacher", teacherId: room.teacherId, actorId: room.teacherId } as never,
      room.roomId,
      { confirmation: `DELETE ${room.roomId}` },
    );

    const result = await new RetentionScheduler(pool, clock, SALT).sweep();

    expect(result.scheduled).toEqual([]);
    const jobs = await deletionJobs(room.roomId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ request_kind: "teacher" });
    expect(accepted.deletionJobId).toBeTruthy();
  });

  it("ignores a room that is still open, however old", async () => {
    const room = await seedLifecycleRoom(pool);
    await new RoomLifecycleService(
      new RoomEventRepository(pool, createCoreEventPayloadRegistry(), clock), clock,
    ).open(room.roomId, room.teacherId, randomUUID());
    await pool.query(
      `UPDATE classroom_room SET closed_at = now() - interval '400 days', retention_policy_id = $2
       WHERE room_id = $1`,
      [room.roomId, POLICY_ID],
    );

    const result = await new RetentionScheduler(pool, clock, SALT).sweep();

    // Retention counts from the end of a session, and this one has not ended.
    expect(result.scheduled).toEqual([]);
  });
});
