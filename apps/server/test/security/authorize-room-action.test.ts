import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  authorizeDeletionStatusRead,
  authorizeRoomAction,
  ROOM_ACTIONS,
  RoomAuthorizationError,
} from "../../src/modules/authorization/authorize-room-action.js";
import { runMigrations } from "../../src/db/migrate.js";
import { resetBusinessTables } from "../db/reset.js";
import { lifecycleDatabaseUrl, seedLifecycleRoom } from "../rooms/lifecycle-test-fixture.js";

const pool = new Pool({ connectionString: lifecycleDatabaseUrl, max: 8 });

const teacherOf = (teacherId: string) => ({
  role: "teacher" as const, teacherId, actorId: teacherId,
});

async function teacherSession(teacherId: string): Promise<string> {
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO auth_session(session_id, token_hash, principal_kind, teacher_id, expires_at)
     VALUES($1, decode(md5(random()::text), 'hex'), 'teacher', $2, now() + interval '8 hours')`,
    [sessionId, teacherId],
  );
  return sessionId;
}

async function studentSession(roomMemberId: string): Promise<string> {
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO auth_session(session_id, token_hash, principal_kind, room_member_id, expires_at)
     VALUES($1, decode(md5(random()::text), 'hex'), 'student', $2, now() + interval '8 hours')`,
    [sessionId, roomMemberId],
  );
  return sessionId;
}

async function studentPrincipal(roomId: string, index = 0) {
  const member = (await pool.query<{ room_member_id: string; actor_id: string }>(
    "SELECT room_member_id, actor_id FROM room_member WHERE room_id = $1 ORDER BY seat_index LIMIT 1 OFFSET $2",
    [roomId, index],
  )).rows[0]!;
  return {
    principal: {
      role: "student" as const,
      roomMemberId: member.room_member_id,
      actorId: member.actor_id,
      roomId,
      pseudonym: "探索者 A",
    },
    sessionId: await studentSession(member.room_member_id),
  };
}

beforeAll(async () => runMigrations(lifecycleDatabaseUrl!, "infra/postgres/migrations"));
beforeEach(async () => resetBusinessTables(lifecycleDatabaseUrl!));
afterAll(async () => pool.end());

describe("one room authorization decision", () => {
  it("admits the owning teacher and the seated student for their own actions", async () => {
    const room = await seedLifecycleRoom(pool);
    const teacherSessionId = await teacherSession(room.teacherId);
    const student = await studentPrincipal(room.roomId);

    const asTeacher = await authorizeRoomAction(
      pool, teacherOf(room.teacherId) as never, teacherSessionId, room.roomId, "room_read",
    );
    const asStudent = await authorizeRoomAction(
      pool, student.principal as never, student.sessionId, room.roomId, "room_command",
    );

    expect(asTeacher).toMatchObject({ role: "teacher", actorId: room.teacherId, action: "room_read" });
    expect(asStudent).toMatchObject({ role: "student", action: "room_command" });
  });

  it("gives a role no action it was not granted", async () => {
    const room = await seedLifecycleRoom(pool);
    const teacherSessionId = await teacherSession(room.teacherId);
    const student = await studentPrincipal(room.roomId);

    // A teacher never uploads media or triggers Nova as a participant.
    for (const action of ["media_write", "agent_trigger"] as const) {
      await expect(authorizeRoomAction(
        pool, teacherOf(room.teacherId) as never, teacherSessionId, room.roomId, action,
      )).rejects.toThrow("ROOM_NOT_FOUND");
    }
    // A student never exports or deletes.
    for (const action of ["export_request", "deletion_request"] as const) {
      await expect(authorizeRoomAction(
        pool, student.principal as never, student.sessionId, room.roomId, action,
      )).rejects.toThrow("ROOM_NOT_FOUND");
    }
  });

  it("makes another teacher's room indistinguishable from one that does not exist", async () => {
    const room = await seedLifecycleRoom(pool);
    const other = await seedLifecycleRoom(pool);
    const otherSessionId = await teacherSession(other.teacherId);

    const foreign = await authorizeRoomAction(
      pool, teacherOf(other.teacherId) as never, otherSessionId, room.roomId, "room_read",
    ).catch((error: RoomAuthorizationError) => error);
    const absent = await authorizeRoomAction(
      pool, teacherOf(other.teacherId) as never, otherSessionId, randomUUID(), "room_read",
    ).catch((error: RoomAuthorizationError) => error);

    // Identical, or the error itself enumerates rooms.
    expect((foreign as RoomAuthorizationError).statusCode).toBe(404);
    expect((foreign as RoomAuthorizationError).code)
      .toBe((absent as RoomAuthorizationError).code);
    expect((foreign as RoomAuthorizationError).statusCode)
      .toBe((absent as RoomAuthorizationError).statusCode);
  });

  it("refuses a student seated in a different room", async () => {
    const room = await seedLifecycleRoom(pool);
    const other = await seedLifecycleRoom(pool);
    const student = await studentPrincipal(other.roomId);

    await expect(authorizeRoomAction(
      pool, student.principal as never, student.sessionId, room.roomId, "room_read",
    )).rejects.toThrow("ROOM_NOT_FOUND");
  });

  it("refuses a revoked or expired session however valid the principal", async () => {
    const room = await seedLifecycleRoom(pool);
    const sessionId = await teacherSession(room.teacherId);
    await pool.query("UPDATE auth_session SET revoked_at = now() WHERE session_id = $1", [sessionId]);

    await expect(authorizeRoomAction(
      pool, teacherOf(room.teacherId) as never, sessionId, room.roomId, "room_read",
    )).rejects.toThrow("ROOM_NOT_FOUND");

    const expired = await teacherSession(room.teacherId);
    await pool.query("UPDATE auth_session SET expires_at = now() - interval '1 hour' WHERE session_id = $1", [expired]);
    await expect(authorizeRoomAction(
      pool, teacherOf(room.teacherId) as never, expired, room.roomId, "room_read",
    )).rejects.toThrow("ROOM_NOT_FOUND");
  });

  it("closes a room being deleted to everyone, including its owner", async () => {
    const room = await seedLifecycleRoom(pool);
    const sessionId = await teacherSession(room.teacherId);
    await pool.query(
      `INSERT INTO deletion_job(deletion_job_id, correlation_id, room_id, room_ref_sha256,
                                request_kind, status, owner_teacher_id, requested_by_teacher_id)
       VALUES($1,$2,$3,repeat('a',64),'teacher','running',$4,$4)`,
      [randomUUID(), randomUUID(), room.roomId, room.teacherId],
    );

    const failure = await authorizeRoomAction(
      pool, teacherOf(room.teacherId) as never, sessionId, room.roomId, "room_read",
    ).catch((error: RoomAuthorizationError) => error);

    expect((failure as RoomAuthorizationError).statusCode).toBe(410);
    expect((failure as RoomAuthorizationError).code).toBe("ROOM_DELETION_IN_PROGRESS");
  });

  it("refuses an unauthenticated caller before it looks at anything", async () => {
    const room = await seedLifecycleRoom(pool);
    for (const [principal, sessionId] of [
      [null, randomUUID()],
      [teacherOf(room.teacherId), undefined],
      [teacherOf(room.teacherId), "not-a-uuid"],
    ] as const) {
      const failure = await authorizeRoomAction(
        pool, principal as never, sessionId as never, room.roomId, "room_read",
      ).catch((error: RoomAuthorizationError) => error);
      expect((failure as RoomAuthorizationError).statusCode).toBe(401);
    }
  });

  it("covers every declared action with a role", () => {
    // An action nobody may perform is dead weight that will later be granted
    // by accident; an action granted to nobody is a route nobody can reach.
    expect(new Set(ROOM_ACTIONS).size).toBe(ROOM_ACTIONS.length);
    expect(ROOM_ACTIONS).toHaveLength(8);
  });
});

describe("deletion status authorization", () => {
  it("shows a job only to the teacher who owns it", async () => {
    const room = await seedLifecycleRoom(pool);
    const other = await seedLifecycleRoom(pool);
    const deletionJobId = randomUUID();
    await pool.query(
      `INSERT INTO deletion_job(deletion_job_id, correlation_id, room_id, room_ref_sha256,
                                request_kind, status, owner_teacher_id, requested_by_teacher_id)
       VALUES($1,$2,$3,repeat('b',64),'teacher','running',$4,$4)`,
      [deletionJobId, randomUUID(), room.roomId, room.teacherId],
    );
    const ownerSession = await teacherSession(room.teacherId);
    const otherSession = await teacherSession(other.teacherId);

    expect(await authorizeDeletionStatusRead(
      pool, teacherOf(room.teacherId) as never, ownerSession, deletionJobId,
    )).toMatchObject({ deletionJobId, ownerTeacherId: room.teacherId });

    await expect(authorizeDeletionStatusRead(
      pool, teacherOf(other.teacherId) as never, otherSession, deletionJobId,
    )).rejects.toThrow("DELETION_JOB_NOT_FOUND");
    // A student never learns that a deletion job exists.
    const student = await studentPrincipal(room.roomId);
    await expect(authorizeDeletionStatusRead(
      pool, student.principal as never, student.sessionId, deletionJobId,
    )).rejects.toThrow("DELETION_JOB_NOT_FOUND");
  });
});
