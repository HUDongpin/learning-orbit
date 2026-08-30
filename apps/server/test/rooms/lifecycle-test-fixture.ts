import { randomBytes, randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type { Clock } from "../../src/clock.js";
import { tokenHash } from "../../src/modules/auth/crypto.js";

export const lifecycleDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!lifecycleDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for lifecycle integration tests");
}

export class MutableClock implements Clock {
  #now: Date;

  constructor(value = "2026-08-30T08:00:00.000Z") {
    this.#now = new Date(value);
  }

  now(): Date {
    return new Date(this.#now);
  }

  set(value: string): void {
    const next = new Date(value);
    if (!Number.isFinite(next.getTime())) throw new Error("INVALID_TEST_CLOCK");
    this.#now = next;
  }
}

export interface SeededLifecycleRoom {
  readonly roomId: string;
  readonly teacherId: string;
  readonly teacherToken: string;
  readonly novaActorId: string;
  readonly memberIds: readonly string[];
}

export async function seedLifecycleRoom(pool: Pool): Promise<SeededLifecycleRoom> {
  const teacherId = randomUUID();
  const roomId = randomUUID();
  const novaActorId = randomUUID();
  const teacherToken = randomBytes(32).toString("base64url");
  await pool.query(
    "INSERT INTO teacher_account(teacher_id, email) VALUES($1, $2)",
    [teacherId, `teacher-${teacherId}@example.test`],
  );
  await pool.query(
    `INSERT INTO classroom_room(
       room_id, room_code_hash, nova_actor_id, teacher_id, topic
     ) VALUES($1, decode($2, 'hex'), $3, $4, '生態系統')`,
    [roomId, randomUUID().replaceAll("-", ""), novaActorId, teacherId],
  );
  await pool.query(
    `INSERT INTO auth_session(
       session_id, token_hash, principal_kind, teacher_id, expires_at
     ) VALUES($1, $2, 'teacher', $3, now() + interval '8 hours')`,
    [randomUUID(), tokenHash(teacherToken), teacherId],
  );

  const memberIds: string[] = [];
  for (let seatIndex = 1; seatIndex <= 4; seatIndex += 1) {
    const memberId = randomUUID();
    memberIds.push(memberId);
    await pool.query(
      `INSERT INTO room_member(
         room_member_id, actor_id, room_id, seat_index, pseudonym, code_hash
       ) VALUES($1, $2, $3, $4, $5, decode($6, 'hex'))`,
      [
        memberId,
        randomUUID(),
        roomId,
        seatIndex,
        `探索者 ${String.fromCharCode(64 + seatIndex)}`,
        randomUUID().replaceAll("-", ""),
      ],
    );
    await pool.query(
      `INSERT INTO auth_session(
         session_id, token_hash, principal_kind, room_member_id, expires_at
       ) VALUES($1, decode($2, 'hex'), 'student', $3, now() + interval '8 hours')`,
      [randomUUID(), randomUUID().replaceAll("-", ""), memberId],
    );
  }
  return { roomId, teacherId, teacherToken, novaActorId, memberIds };
}
