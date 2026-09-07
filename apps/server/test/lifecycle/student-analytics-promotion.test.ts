import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AnalyticsPolicy } from "../../src/modules/analytics/analytics-policy.js";
import { StudentAnalyticsPolicyListener } from "../../src/modules/lifecycle/student-analytics-policy-listener.js";
import {
  parsePolicyChangeNotice,
  POLICY_CHANGE_CHANNEL,
  StudentAnalyticsPromotionService,
} from "../../src/modules/lifecycle/student-analytics-promotion.js";
import { resetBusinessTables } from "../db/reset.js";
import { runMigrations } from "../../src/db/migrate.js";
import {
  lifecycleDatabaseUrl,
  MutableClock,
  seedLifecycleRoom,
} from "../rooms/lifecycle-test-fixture.js";

const pool = new Pool({ connectionString: lifecycleDatabaseUrl, max: 8 });
const digest = createHash("sha256").update("signed-promotion-record").digest("hex");
/** Let a NOTIFY delivered on another connection reach the listener. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 150); });
const window = () => ({
  startsAt: new Date(Date.now() - 60_000),
  expiresAt: new Date(Date.now() + 3_600_000),
});

beforeAll(async () => runMigrations(lifecycleDatabaseUrl!, "infra/postgres/migrations"));
beforeEach(async () => resetBusinessTables(lifecycleDatabaseUrl!));
afterAll(async () => pool.end());

describe("student analytics promotion", () => {
  it("shows a student nothing until a promotion names the exact key", async () => {
    const room = await seedLifecycleRoom(pool);
    const service = new StudentAnalyticsPromotionService(pool);

    expect([...(await service.currentAllowlist(room.roomId))]).toEqual([]);

    const granted = await service.grant({
      roomId: room.roomId,
      promotionRecordSha256: digest,
      featureAllowlist: ["echo.student_approved"],
      ...window(),
    });

    expect(granted).toMatchObject({
      roomId: room.roomId,
      changedKeys: ["echo.student_approved"],
      revision: 1,
    });
    expect([...(await service.currentAllowlist(room.roomId))]).toEqual(["echo.student_approved"]);
  });

  it("promotes each projection key independently", async () => {
    const room = await seedLifecycleRoom(pool);
    const service = new StudentAnalyticsPromotionService(pool);
    await service.grant({
      roomId: room.roomId,
      promotionRecordSha256: digest,
      featureAllowlist: ["trace.student_bundle"],
      ...window(),
    });
    const policy = new AnalyticsPolicy(pool);

    const grant = {
      roomId: room.roomId,
      role: "student" as const,
      studentProjectionAllowlist: await service.currentAllowlist(room.roomId),
    };
    // Promotion of TRACE must not imply ECHO.
    expect(() => policy.assertProjection(grant, "trace.student_bundle")).not.toThrow();
    expect(() => policy.assertProjection(grant, "echo.student_approved"))
      .toThrow("STUDENT_ANALYTICS_NOT_PROMOTED");
  });

  it("revokes as a tombstone with a higher revision, not a delete", async () => {
    const room = await seedLifecycleRoom(pool);
    const service = new StudentAnalyticsPromotionService(pool);
    await service.grant({
      roomId: room.roomId,
      promotionRecordSha256: digest,
      featureAllowlist: ["echo.student_approved", "trace.student_bundle"],
      ...window(),
    });

    const revoked = await service.revoke(room.roomId);

    expect(revoked.revision).toBe(2);
    expect([...revoked.changedKeys].sort())
      .toEqual(["echo.student_approved", "trace.student_bundle"]);
    expect([...(await service.currentAllowlist(room.roomId))]).toEqual([]);
    const row = (await pool.query(
      `SELECT promotion_record_sha256, policy_revision::int AS revision, revoked_at IS NOT NULL AS revoked
       FROM student_analytics_promotion WHERE room_id = $1`,
      [room.roomId],
    )).rows[0];
    expect(row).toEqual({ promotion_record_sha256: digest, revision: 2, revoked: true });
  });

  it("treats an expired window as no promotion at all", async () => {
    const room = await seedLifecycleRoom(pool);
    const service = new StudentAnalyticsPromotionService(pool);
    await service.grant({
      roomId: room.roomId,
      promotionRecordSha256: digest,
      featureAllowlist: ["echo.student_approved"],
      startsAt: new Date(Date.now() - 7_200_000),
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect([...(await service.currentAllowlist(room.roomId))]).toEqual([]);
  });

  it("refuses a record that is not a narrow, well-formed decision", async () => {
    const room = await seedLifecycleRoom(pool);
    const service = new StudentAnalyticsPromotionService(pool);
    const base = { roomId: room.roomId, promotionRecordSha256: digest, ...window() };

    for (const featureAllowlist of [
      ["echo.teacher_shadow"],
      ["echo.student_approved", "echo.student_approved"],
    ] as never[]) {
      await expect(service.grant({ ...base, featureAllowlist }))
        .rejects.toThrow("STUDENT_PROMOTION_RECORD_INVALID");
    }
    await expect(service.grant({ ...base, promotionRecordSha256: "not-a-digest", featureAllowlist: [] }))
      .rejects.toThrow("STUDENT_PROMOTION_RECORD_INVALID");
    await expect(service.grant({
      ...base,
      featureAllowlist: [],
      startsAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now()),
    })).rejects.toThrow("STUDENT_PROMOTION_RECORD_INVALID");
    await expect(service.revoke(room.roomId)).rejects.toThrow("STUDENT_PROMOTION_NOT_FOUND");
  });
});

describe("student analytics policy notices", () => {
  it("validates a notice before anything acts on it", () => {
    const roomId = "11111111-1111-4111-8111-111111111111";
    expect(parsePolicyChangeNotice(JSON.stringify({
      changedKeys: ["echo.student_approved"], revision: 3, roomId,
    }))).toEqual({ roomId, changedKeys: ["echo.student_approved"], revision: 3 });

    for (const payload of [
      "not json",
      "[]",
      JSON.stringify({ roomId, changedKeys: [], revision: 1, extra: true }),
      JSON.stringify({ roomId: "not-a-uuid", changedKeys: [], revision: 1 }),
      JSON.stringify({ roomId, changedKeys: ["echo.teacher_shadow"], revision: 1 }),
      JSON.stringify({ roomId, changedKeys: ["echo.student_approved", "echo.student_approved"], revision: 1 }),
      JSON.stringify({ roomId, changedKeys: [], revision: 0 }),
      JSON.stringify({ roomId, changedKeys: [], revision: 1.5 }),
      `{"roomId":"${roomId}","changedKeys":[],"revision":1,"pad":"${"x".repeat(8000)}"}`,
    ]) {
      expect(() => parsePolicyChangeNotice(payload)).toThrow("STUDENT_POLICY_NOTICE_INVALID");
    }
  });

  it("tells live student sockets the moment a key is withdrawn", async () => {
    const room = await seedLifecycleRoom(pool);
    const service = new StudentAnalyticsPromotionService(pool);
    const clock = new MutableClock("2026-08-30T08:00:00.000Z");
    const degraded: Array<{ roomId: string; projectionKey: string }> = [];
    const listener = new StudentAnalyticsPolicyListener(pool, {
      hub: {
        broadcastDegraded: async (roomId: string, frame: { projectionKey?: string }) => {
          degraded.push({ roomId, projectionKey: frame.projectionKey ?? "" });
        },
        connectedRoomIds: () => [],
      } as never,
      promotions: service,
      clock,
    });
    await listener.start();
    try {
      await service.grant({
        roomId: room.roomId,
        promotionRecordSha256: digest,
        featureAllowlist: ["echo.student_approved", "trace.student_bundle"],
        ...window(),
      });
      await settle();
      // A grant withdraws nothing, so it announces nothing.
      expect(degraded).toEqual([]);

      await service.revoke(room.roomId);
      await settle();

      expect(degraded.map(({ projectionKey }) => projectionKey).sort())
        .toEqual(["echo.student_approved", "trace.student_bundle"]);
      expect(degraded.every(({ roomId }) => roomId === room.roomId)).toBe(true);
    } finally {
      await listener.stop();
    }
  });

  it("ignores a replayed or reordered notice instead of re-opening access", async () => {
    const room = await seedLifecycleRoom(pool);
    const service = new StudentAnalyticsPromotionService(pool);
    const clock = new MutableClock("2026-08-30T08:00:00.000Z");
    const degraded: string[] = [];
    const listener = new StudentAnalyticsPolicyListener(pool, {
      hub: {
        broadcastDegraded: async (_roomId: string, frame: { projectionKey?: string }) => {
          degraded.push(frame.projectionKey ?? "");
        },
        connectedRoomIds: () => [],
      } as never,
      promotions: service,
      clock,
    });
    await listener.start();
    try {
      await service.grant({
        roomId: room.roomId,
        promotionRecordSha256: digest,
        featureAllowlist: ["echo.student_approved"],
        ...window(),
      });
      await settle();
      await service.revoke(room.roomId);
      await settle();
      expect(degraded).toEqual(["echo.student_approved"]);
      const afterRevoke = degraded.length;

      // Replay the revision that was already applied.
      await pool.query(
        "SELECT pg_notify($1, $2)",
        [POLICY_CHANGE_CHANNEL,
          JSON.stringify({ changedKeys: ["echo.student_approved"], revision: 2, roomId: room.roomId })],
      );
      // And a payload nothing may act on.
      await pool.query("SELECT pg_notify($1, $2)", [POLICY_CHANGE_CHANNEL, "not json"]);
      await settle();

      expect(degraded).toHaveLength(afterRevoke);
    } finally {
      await listener.stop();
    }
  });

  it("reconciles every connected room when it starts", async () => {
    const room = await seedLifecycleRoom(pool);
    const service = new StudentAnalyticsPromotionService(pool);
    await service.grant({
      roomId: room.roomId,
      promotionRecordSha256: digest,
      featureAllowlist: ["echo.student_approved"],
      ...window(),
    });
    const degraded: string[] = [];
    const listener = new StudentAnalyticsPolicyListener(pool, {
      hub: {
        broadcastDegraded: async (_roomId: string, frame: { projectionKey?: string }) => {
          degraded.push(frame.projectionKey ?? "");
        },
        connectedRoomIds: () => [room.roomId],
      } as never,
      promotions: service,
      clock: new MutableClock("2026-08-30T08:00:00.000Z"),
    });

    await listener.start();
    try {
      // A notification lost while the listener was down cannot leave stale
      // access: on start every connected room is re-read, and the key that is
      // not promoted is announced as withheld.
      expect(degraded).toEqual(["trace.student_bundle"]);
    } finally {
      await listener.stop();
    }
  });
});
