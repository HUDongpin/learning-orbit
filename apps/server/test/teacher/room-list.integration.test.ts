import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { teacherRoomListContract } from "@learning-orbit/contracts";
import { buildApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { tokenHash } from "../../src/modules/auth/crypto.js";
import { resetBusinessTables } from "../db/reset.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const configuredDatabaseUrl = databaseUrl ?? "";
const allowedOrigin = "https://app.learning-orbit.test";

describe.skipIf(!databaseUrl)("teacher room-list PostgreSQL integration", () => {
  const pool = new Pool({ connectionString: configuredDatabaseUrl });
  let app: FastifyInstance;
  let ownerToken: string;
  let otherToken: string;
  let studentToken: string;
  let expectedOwnerOrder: string[];
  let foreignRoomId: string;

  beforeAll(async () => {
    await runMigrations(configuredDatabaseUrl, "infra/postgres/migrations");
  });

  beforeEach(async () => {
    await resetBusinessTables(configuredDatabaseUrl);
    const ownerId = randomUUID();
    const otherId = randomUUID();
    ownerToken = randomBytes(32).toString("base64url");
    otherToken = randomBytes(32).toString("base64url");
    studentToken = randomBytes(32).toString("base64url");
    await pool.query(
      "INSERT INTO teacher_account(teacher_id,email) VALUES($1,$2),($3,$4)",
      [ownerId, `${ownerId}@example.test`, otherId, `${otherId}@example.test`],
    );
    await pool.query(
      `INSERT INTO auth_session(session_id,token_hash,principal_kind,teacher_id,expires_at)
       VALUES($1,$2,'teacher',$3,now()+interval '8 hours'),($4,$5,'teacher',$6,now()+interval '8 hours')`,
      [randomUUID(), tokenHash(ownerToken), ownerId, randomUUID(), tokenHash(otherToken), otherId],
    );

    const active = [
      { status: "open", ageDays: 10 },
      { status: "paused", ageDays: 9 },
      { status: "scheduled", ageDays: 8 },
    ] as const;
    const activeIds: string[] = [];
    for (const [index, item] of active.entries()) {
      const roomId = randomUUID();
      activeIds.push(roomId);
      await pool.query(
        `INSERT INTO classroom_room(
           room_id,room_code_hash,nova_actor_id,teacher_id,topic,status,starts_at,closes_at,created_at
         ) VALUES($1,$2,$3,$4,$5,$6,
           CASE WHEN $6='scheduled' THEN NULL ELSE now()-($7::text||' days')::interval END,
           CASE WHEN $6='scheduled' THEN NULL ELSE now()-($7::text||' days')::interval+interval '45 minutes' END,
           now()-($7::text||' days')::interval)`,
        [roomId, randomBytes(32), randomUUID(), ownerId, `active-${index}`, item.status, item.ageDays],
      );
    }

    const closed: Array<{ roomId: string; createdAt: Date }> = [];
    const closedBase = new Date("2026-08-31T00:00:00.000Z");
    for (let index = 0; index < 49; index += 1) {
      const roomId = index === 0
        ? "ffffffff-ffff-4fff-bfff-fffffffffff0"
        : index === 1 ? "00000000-0000-4000-8000-000000000001" : randomUUID();
      const createdAt = new Date(closedBase.getTime() - Math.max(0, index - 1) * 60_000);
      closed.push({ roomId, createdAt });
      await pool.query(
        `INSERT INTO classroom_room(
           room_id,room_code_hash,nova_actor_id,teacher_id,topic,status,starts_at,closes_at,closed_at,created_at
         ) VALUES($1,$2,$3,$4,$5,'closed',now()-interval '2 hours',now()-interval '75 minutes',
           now()-interval '75 minutes',$6::timestamptz)`,
        [roomId, randomBytes(32), randomUUID(), ownerId, `closed-${index}`, createdAt],
      );
    }
    expectedOwnerOrder = [
      activeIds[2]!, activeIds[1]!, activeIds[0]!,
      ...closed.sort((left, right) => (
        right.createdAt.getTime() - left.createdAt.getTime()
        || (left.roomId < right.roomId ? 1 : -1)
      )).slice(0, 47).map(({ roomId }) => roomId),
    ];

    foreignRoomId = randomUUID();
    await pool.query(
      `INSERT INTO classroom_room(room_id,room_code_hash,nova_actor_id,teacher_id,topic,status,created_at)
       VALUES($1,$2,$3,$4,'foreign-secret','open',now()+interval '1 day')`,
      [foreignRoomId, randomBytes(32), randomUUID(), otherId],
    );

    const studentRoomId = activeIds[0]!;
    const memberId = randomUUID();
    await pool.query(
      `INSERT INTO room_member(room_member_id,actor_id,room_id,seat_index,pseudonym,code_hash)
       VALUES($1,$2,$3,1,'探索者 A',$4)`,
      [memberId, randomUUID(), studentRoomId, randomBytes(32)],
    );
    await pool.query(
      `INSERT INTO auth_session(session_id,token_hash,principal_kind,room_member_id,expires_at)
       VALUES($1,$2,'student',$3,now()+interval '8 hours')`,
      [randomUUID(), tokenHash(studentToken), memberId],
    );

    app = await buildApp({
      pool,
      config: { allowedOrigins: [allowedOrigin], publicBaseOrigin: allowedOrigin },
    });
  });

  afterAll(async () => {
    await app?.close();
    await resetBusinessTables(configuredDatabaseUrl);
    await pool.end();
  });

  function headers(token?: string): Record<string, string> {
    return { origin: allowedOrigin, ...(token ? { cookie: `lo_session=${token}` } : {}) };
  }

  it("authenticates real cookies, filters ownership, sorts active first, and truncates at 50", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/v1/teacher/rooms", headers: headers() });
    expect([anonymous.statusCode, anonymous.json()]).toEqual([401, { code: "AUTH_REQUIRED" }]);
    expect(anonymous.headers["cache-control"]).toBe("no-store");

    const hidden = await app.inject({ method: "GET", url: "/v1/teacher/rooms", headers: headers(studentToken) });
    expect([hidden.statusCode, hidden.json()]).toEqual([404, { code: "ROOM_NOT_FOUND" }]);
    expect(hidden.headers["cache-control"]).toBe("no-store");

    const unsupportedQuery = await app.inject({
      method: "GET", url: "/v1/teacher/rooms?teacherId=other", headers: headers(ownerToken),
    });
    expect([unsupportedQuery.statusCode, unsupportedQuery.json()]).toEqual([400, { code: "INVALID_QUERY" }]);
    expect(unsupportedQuery.headers["cache-control"]).toBe("no-store");

    const ownerResponse = await app.inject({ method: "GET", url: "/v1/teacher/rooms", headers: headers(ownerToken) });
    expect(ownerResponse.statusCode).toBe(200);
    expect(ownerResponse.headers["cache-control"]).toBe("no-store");
    const owner = teacherRoomListContract.parse(ownerResponse.json());
    expect(owner.truncated).toBe(true);
    expect(owner.rooms).toHaveLength(50);
    expect(owner.rooms.map(({ roomId }) => roomId)).toEqual(expectedOwnerOrder);
    expect(owner.rooms.every(({ roomId }) => roomId !== foreignRoomId)).toBe(true);
    expect(Object.keys(owner.rooms[0]!).sort()).toEqual([
      "closesAt", "createdAt", "durationSeconds", "roomId", "startsAt", "status", "topic",
    ]);

    const otherResponse = await app.inject({ method: "GET", url: "/v1/teacher/rooms", headers: headers(otherToken) });
    const other = teacherRoomListContract.parse(otherResponse.json());
    expect(other).toEqual({
      rooms: [expect.objectContaining({ roomId: foreignRoomId, topic: "foreign-secret" })],
      truncated: false,
    });
  });
});
