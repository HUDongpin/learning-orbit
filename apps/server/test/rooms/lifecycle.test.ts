import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCoreEventPayloadRegistry } from "@learning-orbit/contracts";
import { buildApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { RoomError } from "../../src/modules/rooms/errors.js";
import { RoomEventRepository } from "../../src/modules/rooms/room-event-repository.js";
import { RoomLifecycleService } from "../../src/modules/rooms/lifecycle-service.js";
import { CodeHasher } from "../../src/modules/rooms/seat-codes.js";
import { resetBusinessTables } from "../db/reset.js";
import {
  lifecycleDatabaseUrl,
  MutableClock,
  seedLifecycleRoom,
} from "./lifecycle-test-fixture.js";

const pool = new Pool({ connectionString: lifecycleDatabaseUrl, max: 12 });
let clock: MutableClock;
let lifecycle: RoomLifecycleService;

async function rows<Type extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<Type[]> {
  return (await pool.query<Type>(text, [...values])).rows;
}

beforeAll(async () => runMigrations(lifecycleDatabaseUrl, "infra/postgres/migrations"));
beforeEach(async () => {
  await resetBusinessTables(lifecycleDatabaseUrl);
  clock = new MutableClock();
  lifecycle = new RoomLifecycleService(
    new RoomEventRepository(pool, createCoreEventPayloadRegistry(), clock),
    clock,
  );
});
afterEach(async () => resetBusinessTables(lifecycleDatabaseUrl));
afterAll(async () => pool.end());

describe("forty-five-minute room lifecycle", () => {
  it("rejects wrong-owner due transitions without mutation and retries successful commands after deadline", async () => {
    const room = await seedLifecycleRoom(pool);
    await lifecycle.open(room.roomId, room.teacherId, randomUUID());
    const wrong = randomUUID();
    clock.set("2026-08-30T08:45:00.000Z");
    for (const action of ["pause", "resume", "close"] as const) {
      await expect(lifecycle[action](room.roomId, wrong, randomUUID())).rejects.toEqual(new RoomError("FORBIDDEN"));
    }
    clock.set("2026-08-30T08:10:00.000Z");
    const commandId = randomUUID();
    const paused = await lifecycle.pause(room.roomId, room.teacherId, commandId);
    clock.set("2026-08-30T08:45:00.000Z");
    expect(await lifecycle.pause(room.roomId, room.teacherId, commandId)).toEqual(paused);
  });
  it("opens for exactly forty-five minutes and pause/resume never extend the deadline", async () => {
    const room = await seedLifecycleRoom(pool);
    const wrongOwner = randomUUID();
    await expect(lifecycle.open(room.roomId, wrongOwner, randomUUID())).rejects.toEqual(
      new RoomError("FORBIDDEN"),
    );

    clock.set("2026-08-30T08:00:00.000Z");
    const opened = await lifecycle.open(room.roomId, room.teacherId, randomUUID());
    expect(opened).toMatchObject({
      type: "room.opened",
      actorId: room.teacherId,
      actorKind: "human",
      actorRole: "teacher",
      payload: {
        startsAt: "2026-08-30T08:00:00.000Z",
        closesAt: "2026-08-30T08:45:00.000Z",
      },
    });

    clock.set("2026-08-30T08:10:00.000Z");
    const pauseId = randomUUID();
    const paused = await lifecycle.pause(room.roomId, room.teacherId, pauseId);
    clock.set("2026-08-30T08:11:00.000Z");
    expect(await lifecycle.pause(room.roomId, room.teacherId, pauseId)).toEqual(paused);

    clock.set("2026-08-30T08:20:00.000Z");
    const resumeId = randomUUID();
    const resumed = await lifecycle.resume(room.roomId, room.teacherId, resumeId);
    clock.set("2026-08-30T08:21:00.000Z");
    expect(await lifecycle.resume(room.roomId, room.teacherId, resumeId)).toEqual(resumed);

    const state = await rows<{
      status: string;
      starts_at: Date;
      closes_at: Date;
    }>(
      "SELECT status, starts_at, closes_at FROM classroom_room WHERE room_id = $1",
      [room.roomId],
    );
    expect(state[0]).toMatchObject({ status: "open" });
    expect(state[0]?.starts_at.toISOString()).toBe("2026-08-30T08:00:00.000Z");
    expect(state[0]?.closes_at.toISOString()).toBe("2026-08-30T08:45:00.000Z");
    const types = await rows<{ type: string }>(
      "SELECT type FROM room_event WHERE room_id = $1 ORDER BY room_seq",
      [room.roomId],
    );
    expect(types.map(({ type }) => type)).toEqual([
      "room.opened",
      "room.paused",
      "room.resumed",
    ]);
  });

  it("rejects illegal states and a causation reused for another transition", async () => {
    const room = await seedLifecycleRoom(pool);
    await expect(lifecycle.pause(room.roomId, room.teacherId, randomUUID())).rejects.toEqual(
      new RoomError("ROOM_NOT_OPEN"),
    );
    await expect(lifecycle.close(room.roomId, room.teacherId, randomUUID())).rejects.toEqual(
      new RoomError("ROOM_NOT_OPEN"),
    );
    const openId = randomUUID();
    await lifecycle.open(room.roomId, room.teacherId, openId);
    await expect(lifecycle.open(room.roomId, room.teacherId, randomUUID())).rejects.toEqual(
      new RoomError("INVALID_COMMAND"),
    );
    await expect(lifecycle.pause(room.roomId, room.teacherId, openId)).rejects.toEqual(
      new RoomError("INVALID_COMMAND"),
    );
    await expect(lifecycle.resume(room.roomId, room.teacherId, randomUUID())).rejects.toEqual(
      new RoomError("ROOM_NOT_OPEN"),
    );
  });

  it("manual close preserves read-only sessions and ordered analytics while cancelling other room jobs", async () => {
    const room = await seedLifecycleRoom(pool);
    const opened = await lifecycle.open(room.roomId, room.teacherId, randomUUID());
    await pool.query(
      `INSERT INTO worker_job(job_type, room_id, dedupe_key, payload, status)
       VALUES
         ('probe.queued.v1', $1, $2, '{}', 'queued'),
         ('probe.retryable.v1', $1, $3, '{}', 'retryable')`,
      [room.roomId, `queued:${randomUUID()}`, `retryable:${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO worker_job(
         job_type, room_id, dedupe_key, payload, status,
         analytics_order_seq, analytics_order_kind
       ) VALUES('analytics.replay-room.v1', $1, $2, '{}', 'queued', 1, 1)`,
      [room.roomId, `analytics.replay-room.v1:${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO worker_job(
         job_type, room_id, dedupe_key, payload, status,
         claim_generation, claim_token, locked_at, locked_by
       ) VALUES('probe.running.v1', $1, $2, '{}', 'running', 1, $3, now(), 'worker-a')`,
      [room.roomId, `running:${randomUUID()}`, randomUUID()],
    );

    clock.set("2026-08-30T08:30:00.000Z");
    const closeId = randomUUID();
    const closed = await lifecycle.close(room.roomId, room.teacherId, closeId);
    clock.set("2026-08-30T08:31:00.000Z");
    expect(await lifecycle.close(room.roomId, room.teacherId, closeId)).toEqual(closed);
    await expect(lifecycle.close(room.roomId, room.teacherId, randomUUID())).rejects.toEqual(
      new RoomError("ROOM_NOT_OPEN"),
    );

    const sessions = await rows<{ revoked: boolean }>(
      `SELECT revoked_at IS NOT NULL AS revoked FROM auth_session
       WHERE room_member_id = ANY($1::uuid[]) ORDER BY session_id`,
      [room.memberIds],
    );
    expect(sessions).toHaveLength(4);
    expect(sessions.every(({ revoked }) => !revoked)).toBe(true);
    const jobs = await rows<{
      job_id: string;
      job_type: string;
      source_event_id: string | null;
      status: string;
      claim_token: string | null;
      locked_at: Date | null;
      locked_by: string | null;
    }>(
      `SELECT job_id, job_type, source_event_id, status, claim_token, locked_at, locked_by FROM worker_job
       WHERE room_id = $1 ORDER BY job_id`,
      [room.roomId],
    );
    expect(jobs.length).toBeGreaterThanOrEqual(4);
    const consumeJobs = jobs.filter(({ job_type }) => job_type === "analytics.consume.v1");
    expect(consumeJobs).toHaveLength(2);
    expect(new Set(consumeJobs.map(({ source_event_id }) => source_event_id)))
      .toEqual(new Set([opened.eventId, closed.eventId]));
    const replayJobs = jobs.filter(({ job_type }) => job_type === "analytics.replay-room.v1");
    expect(replayJobs).toHaveLength(1);
    expect([...consumeJobs, ...replayJobs].every((job) => (
      job.status === "queued" && job.claim_token === null
      && job.locked_at === null && job.locked_by === null
    ))).toBe(true);
    expect(jobs.filter(({ job_type }) => (
      job_type !== "analytics.consume.v1" && job_type !== "analytics.replay-room.v1"
    )).every((job) => (
      job.status === "cancelled"
      && job.claim_token === null
      && job.locked_at === null
      && job.locked_by === null
    ))).toBe(true);
    const eventTypes = await rows<{ type: string }>(
      "SELECT type FROM room_event WHERE room_id = $1 ORDER BY room_seq",
      [room.roomId],
    );
    expect(eventTypes.map(({ type }) => type)).toEqual(["room.opened", "room.closed"]);
  });

  it("converges a due room before a new transition while preserving successful retry identity", async () => {
    const room = await seedLifecycleRoom(pool);
    const openId = randomUUID();
    const opened = await lifecycle.open(room.roomId, room.teacherId, openId);
    await lifecycle.pause(room.roomId, room.teacherId, randomUUID());
    const job = (await rows<{ job_id: string }>(
      "SELECT job_id FROM worker_job WHERE room_id = $1 AND job_type = 'room.auto-close.v1'",
      [room.roomId],
    ))[0];
    expect(job).toBeDefined();

    clock.set("2026-08-30T08:45:00.000Z");
    await expect(lifecycle.resume(room.roomId, room.teacherId, randomUUID())).rejects.toEqual(
      new RoomError("ROOM_NOT_OPEN"),
    );
    expect(await lifecycle.open(room.roomId, room.teacherId, openId)).toEqual(opened);
    expect(await lifecycle.closeIfDue(room.roomId)).toBeNull();

    const state = await rows<{ status: string; closed_at: Date }>(
      "SELECT status, closed_at FROM classroom_room WHERE room_id = $1",
      [room.roomId],
    );
    expect(state[0]).toMatchObject({ status: "closed" });
    expect(state[0]?.closed_at.toISOString()).toBe("2026-08-30T08:45:00.000Z");
    const events = await rows<{
      type: string;
      actor_id: string;
      causation_id: string;
      event_time: Date;
    }>(
      `SELECT type, actor_id, causation_id, event_time FROM room_event
       WHERE room_id = $1 ORDER BY room_seq`,
      [room.roomId],
    );
    expect(events.map(({ type }) => type)).toEqual([
      "room.opened",
      "room.paused",
      "room.closed",
    ]);
    expect(events[2]).toMatchObject({
      actor_id: job?.job_id,
      causation_id: job?.job_id,
    });
    expect(events[2]?.event_time.toISOString()).toBe("2026-08-30T08:45:00.000Z");
  });

  it("authorized GET lazily closes a room at the deterministic deadline", async () => {
    const room = await seedLifecycleRoom(pool);
    await lifecycle.open(room.roomId, room.teacherId, randomUUID());
    clock.set("2026-08-30T08:45:00.000Z");
    const app = await buildApp({
      pool,
      clock,
      codeHasher: new CodeHasher(1, new Map([[1, Buffer.alloc(32, 0x51)]])),
      config: {
        allowedOrigins: ["https://app.learning-orbit.test"],
        publicBaseOrigin: "https://app.learning-orbit.test",
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/rooms/${room.roomId}`,
        headers: {
          origin: "https://app.learning-orbit.test",
          cookie: `lo_session=${room.teacherToken}`,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "closed" });
      const eventPage = await app.inject({
        method: "GET",
        url: `/v1/rooms/${room.roomId}/events?afterSeq=0&limit=500`,
        headers: {
          origin: "https://app.learning-orbit.test",
          cookie: `lo_session=${room.teacherToken}`,
        },
      });
      expect(eventPage.statusCode).toBe(200);
      expect(eventPage.json().events.map(({ type }: { type: string }) => type))
        .toEqual(["room.opened", "room.closed"]);
      expect((await rows<{ count: number }>(
        `SELECT count(*)::int AS count FROM room_event
         WHERE room_id = $1 AND type = 'room.closed'`,
        [room.roomId],
      ))[0]).toEqual({ count: 1 });
    } finally {
      await app.close();
    }
  });
});
