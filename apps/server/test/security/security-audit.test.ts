import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AnalyticsPolicy } from "../../src/modules/analytics/analytics-policy.js";
import {
  AUDITED_ACTIONS,
  roomRefHash,
  SecurityAuditLog,
} from "../../src/modules/security/security-audit.js";
import { runMigrations } from "../../src/db/migrate.js";
import { resetBusinessTables } from "../db/reset.js";
import { lifecycleDatabaseUrl, seedLifecycleRoom } from "../rooms/lifecycle-test-fixture.js";

const pool = new Pool({ connectionString: lifecycleDatabaseUrl, max: 8 });
const SALT = "audit-salt";

const rows = async () => (await pool.query<{
  action: string; outcome: string; reason_code: string;
  principal_kind: string; room_ref_sha256: string | null;
}>(
  `SELECT action, outcome, reason_code, principal_kind, room_ref_sha256
   FROM security_audit_event ORDER BY occurred_at ASC, action ASC`,
)).rows;

beforeAll(async () => runMigrations(lifecycleDatabaseUrl!, "infra/postgres/migrations"));
beforeEach(async () => resetBusinessTables(lifecycleDatabaseUrl!));
afterAll(async () => pool.end());

describe("security audit log", () => {
  it("writes a content-free row that names no room it audits", async () => {
    const room = await seedLifecycleRoom(pool);
    const log = new SecurityAuditLog(pool, SALT);

    await log.record({
      principalKind: "teacher",
      action: "room.read",
      outcome: "allowed",
      reasonCode: "TEACHER",
      correlationId: randomUUID(),
      roomId: room.roomId,
    });

    const [entry] = await rows();
    expect(entry).toEqual({
      action: "room.read",
      outcome: "allowed",
      reason_code: "TEACHER",
      principal_kind: "teacher",
      room_ref_sha256: roomRefHash(room.roomId, SALT),
    });
    // The plain room identifier never reaches the trail.
    expect(entry!.room_ref_sha256).not.toContain(room.roomId);
  });

  it("bounds a reason code instead of letting free text into the trail", async () => {
    const log = new SecurityAuditLog(pool, SALT);
    await log.record({
      principalKind: "service",
      action: "service.callback",
      outcome: "failed",
      reasonCode: "connect ECONNREFUSED 10.0.0.5:5432 while reading room 42",
      correlationId: randomUUID(),
      roomId: null,
    });
    const [entry] = await rows();
    expect(entry!.reason_code).toMatch(/^[A-Z0-9_]{1,64}$/);
    expect(entry!.room_ref_sha256).toBeNull();
  });

  it("never turns an unrecorded decision into a failed one", async () => {
    const broken = new SecurityAuditLog(
      { query: async () => { throw new Error("audit table is gone"); } } as never,
      SALT,
    );
    await expect(broken.record({
      principalKind: "student",
      action: "analytics.read",
      outcome: "allowed",
      reasonCode: "STUDENT",
      correlationId: randomUUID(),
      roomId: null,
    })).resolves.toBeUndefined();
  });

  it("refuses an action the schema does not define", async () => {
    const log = new SecurityAuditLog(pool, SALT);
    await expect(log.write(pool, {
      principalKind: "teacher",
      action: "room.exfiltrate" as never,
      outcome: "allowed",
      reasonCode: "NOPE",
      correlationId: randomUUID(),
    })).rejects.toThrow("SECURITY_AUDIT_ACTION_INVALID");
    expect(await rows()).toEqual([]);
    expect(AUDITED_ACTIONS).toHaveLength(7);
  });

  it("records an analytics decision whether it was allowed or refused", async () => {
    const room = await seedLifecycleRoom(pool);
    const log = new SecurityAuditLog(pool, SALT);
    const policy = new AnalyticsPolicy(pool, log);

    // No principal at all: a refusal that previously left no trace.
    await expect(policy.requireRoomAccess(null, room.roomId, "latest"))
      .rejects.toThrow("AUTH_REQUIRED");
    // A teacher whose room has no current retention policy.
    await expect(policy.requireRoomAccess(
      { role: "teacher", teacherId: room.teacherId } as never,
      room.roomId,
      "latest",
      randomUUID(),
    )).rejects.toThrow();

    const recorded = await rows();
    expect(recorded).toHaveLength(2);
    expect(recorded.every(({ action }) => action === "analytics.read")).toBe(true);
    expect(recorded.every(({ outcome }) => outcome === "rejected")).toBe(true);
    expect(recorded[0]).toMatchObject({ principal_kind: "anonymous", reason_code: "AUTH_REQUIRED" });
    expect(recorded[1]).toMatchObject({ principal_kind: "teacher" });
    expect(recorded.every(({ room_ref_sha256: hash }) => hash === roomRefHash(room.roomId, SALT)))
      .toBe(true);
  });
});
