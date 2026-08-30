import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCoreEventPayloadRegistry } from "@learning-orbit/contracts";
import { runMigrations } from "../../src/db/migrate.js";
import { RoomEventRepository } from "../../src/modules/rooms/room-event-repository.js";
import { RoomLifecycleService } from "../../src/modules/rooms/lifecycle-service.js";
import { resetBusinessTables } from "../db/reset.js";
import {
  lifecycleDatabaseUrl,
  MutableClock,
  seedLifecycleRoom,
} from "./lifecycle-test-fixture.js";

const pool = new Pool({ connectionString: lifecycleDatabaseUrl, max: 12 });
let clock: MutableClock;
let lifecycle: RoomLifecycleService;

beforeAll(async () => runMigrations(lifecycleDatabaseUrl, "infra/postgres/migrations"));
beforeEach(async () => {
  await resetBusinessTables(lifecycleDatabaseUrl);
  clock = new MutableClock("2026-08-30T08:00:00.000Z");
  lifecycle = new RoomLifecycleService(
    new RoomEventRepository(pool, createCoreEventPayloadRegistry(), clock),
    clock,
  );
});
afterEach(async () => {
  await pool.query(
    "ALTER TABLE worker_job DROP CONSTRAINT IF EXISTS auto_close_enqueue_test_reject",
  );
  await resetBusinessTables(lifecycleDatabaseUrl);
});
afterAll(async () => pool.end());

describe("room auto-close enqueue", () => {
  it("atomically enqueues one exact job bound to the canonical opened event", async () => {
    const room = await seedLifecycleRoom(pool);
    const commandId = randomUUID();
    const opened = await lifecycle.open(room.roomId, room.teacherId, commandId);
    clock.set("2026-08-30T08:01:00.000Z");
    expect(await lifecycle.open(room.roomId, room.teacherId, commandId)).toEqual(opened);

    const result = await pool.query<{
      job_type: string;
      room_id: string;
      source_event_id: string;
      dedupe_key: string;
      correlation_id: string;
      payload: Record<string, unknown>;
      status: string;
      run_after: Date;
      claim_token: string | null;
      locked_at: Date | null;
      locked_by: string | null;
    }>(
      `SELECT job_type, room_id, source_event_id, dedupe_key, correlation_id,
              payload, status, run_after, claim_token, locked_at, locked_by
       FROM worker_job WHERE room_id = $1 AND job_type = 'room.auto-close.v1'`,
      [room.roomId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      job_type: "room.auto-close.v1",
      room_id: room.roomId,
      source_event_id: opened.eventId,
      dedupe_key: `room.auto-close.v1:${room.roomId}`,
      correlation_id: opened.correlationId,
      payload: { roomId: room.roomId, closesAt: "2026-08-30T08:45:00.000Z" },
      status: "queued",
      claim_token: null,
      locked_at: null,
      locked_by: null,
    });
    expect(result.rows[0]?.run_after.toISOString()).toBe("2026-08-30T08:45:00.000Z");
    const analytics = await pool.query<{ job_type: string; source_event_id: string; analytics_order_kind: number }>(
      "SELECT job_type, source_event_id, analytics_order_kind FROM worker_job WHERE room_id = $1 AND job_type = 'analytics.consume.v1'",
      [room.roomId],
    );
    expect(analytics.rows).toEqual([{ job_type: "analytics.consume.v1", source_event_id: opened.eventId, analytics_order_kind: 0 }]);
  });

  it("serializes concurrent opens and creates only one event, outbox, and job", async () => {
    const room = await seedLifecycleRoom(pool);
    const commandId = randomUUID();
    const results = await Promise.all([
      lifecycle.open(room.roomId, room.teacherId, commandId),
      lifecycle.open(room.roomId, room.teacherId, commandId),
    ]);
    expect(results[0]).toEqual(results[1]);
    const counts = await pool.query<{
      events: number;
      outbox: number;
      jobs: number;
      next_room_seq: string;
    }>(
      `SELECT
         (SELECT count(*)::int FROM room_event WHERE room_id = $1) AS events,
         (SELECT count(*)::int FROM outbox_event WHERE room_id = $1) AS outbox,
         (SELECT count(*)::int FROM worker_job WHERE room_id = $1 AND job_type = 'room.auto-close.v1') AS jobs,
         next_room_seq
       FROM classroom_room WHERE room_id = $1`,
      [room.roomId],
    );
    expect(counts.rows[0]).toEqual({ events: 1, outbox: 1, jobs: 1, next_room_seq: "2" });
  });

  it("rolls back room state, event, outbox, job, and sequence when enqueue fails", async () => {
    const room = await seedLifecycleRoom(pool);
    await pool.query(
      `ALTER TABLE worker_job ADD CONSTRAINT auto_close_enqueue_test_reject
       CHECK (job_type <> 'room.auto-close.v1')`,
    );
    await expect(lifecycle.open(room.roomId, room.teacherId, randomUUID())).rejects.toEqual(
      new Error("ROOM_AUTO_CLOSE_ENQUEUE_FAILED"),
    );
    const failed = await pool.query<{
      status: string;
      next_room_seq: string;
      events: number;
      outbox: number;
      jobs: number;
    }>(
      `SELECT status, next_room_seq,
         (SELECT count(*)::int FROM room_event WHERE room_id = $1) AS events,
         (SELECT count(*)::int FROM outbox_event WHERE room_id = $1) AS outbox,
         (SELECT count(*)::int FROM worker_job WHERE room_id = $1) AS jobs
       FROM classroom_room WHERE room_id = $1`,
      [room.roomId],
    );
    expect(failed.rows[0]).toEqual({
      status: "scheduled",
      next_room_seq: "1",
      events: 0,
      outbox: 0,
      jobs: 0,
    });
    await pool.query("ALTER TABLE worker_job DROP CONSTRAINT auto_close_enqueue_test_reject");
    expect((await lifecycle.open(room.roomId, room.teacherId, randomUUID())).roomSeq).toBe(1);
  });
});
