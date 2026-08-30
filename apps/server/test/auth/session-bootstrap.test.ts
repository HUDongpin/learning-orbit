import { randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { buildApp } from "../../src/app.js";
import { tokenHash } from "../../src/modules/auth/crypto.js";
import { resetBusinessTables } from "../db/reset.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for auth tests");
const allowedOrigin = "https://app.learning-orbit.test";

describe("session bootstrap", () => {
  beforeEach(async () => resetBusinessTables(databaseUrl));
  afterEach(async () => resetBusinessTables(databaseUrl));

  it("returns server-owned teacher and student identities, rejects no cookie, and revokes atomically", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const teacherId = randomUUID(); const roomId = randomUUID(); const memberId = randomUUID(); const actorId = randomUUID(); const novaId = randomUUID();
    const teacherToken = randomBytes(32).toString("base64url"); const studentToken = randomBytes(32).toString("base64url");
    try {
      await pool.query("INSERT INTO teacher_account(teacher_id, email) VALUES ($1, $2)", [teacherId, "teacher@example.edu"]);
      await pool.query(`INSERT INTO classroom_room(room_id, room_code_hash, nova_actor_id, teacher_id, topic)
                        VALUES ($1, $2, $3, $4, 'topic')`, [roomId, randomBytes(32), novaId, teacherId]);
      await pool.query(`INSERT INTO room_member(room_member_id, actor_id, room_id, seat_index, pseudonym, code_hash)
                        VALUES ($1, $2, $3, 1, '探索者 A', $4)`, [memberId, actorId, roomId, randomBytes(32)]);
      await pool.query(`INSERT INTO auth_session(session_id, token_hash, principal_kind, teacher_id, expires_at)
                        VALUES ($1, $2, 'teacher', $3, now() + interval '8 hours')`, [randomUUID(), tokenHash(teacherToken), teacherId]);
      await pool.query(`INSERT INTO auth_session(session_id, token_hash, principal_kind, room_member_id, expires_at)
                        VALUES ($1, $2, 'student', $3, now() + interval '8 hours')`, [randomUUID(), tokenHash(studentToken), memberId]);
    } finally { await pool.end(); }
    const app = await buildApp({ databaseUrl, config: { allowedOrigins: [allowedOrigin], publicBaseOrigin: allowedOrigin } });
    const none = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { origin: allowedOrigin } });
    const teacher = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { origin: allowedOrigin, cookie: `lo_session=${teacherToken}` } });
    const student = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { origin: allowedOrigin, cookie: `lo_session=${studentToken}` } });
    expect(none.statusCode).toBe(401);
    expect(teacher.json()).toEqual({ role: "teacher", teacherId, actorId: teacherId });
    expect(student.json()).toEqual({ role: "student", roomId, roomMemberId: memberId, actorId, pseudonym: "探索者 A", nova: { actorId: novaId, actorKind: "agent", actorRole: "socratic_facilitator", displayName: "Nova Agent" } });
    const logout = await app.inject({ method: "DELETE", url: "/v1/auth/session", headers: { origin: allowedOrigin, cookie: `lo_session=${studentToken}` } });
    expect(logout.statusCode).toBe(204); expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
    expect((await app.inject({ method: "GET", url: "/v1/auth/session", headers: { origin: allowedOrigin, cookie: `lo_session=${studentToken}` } })).statusCode).toBe(401);
    await app.close();
  });

  it("rejects expired and already revoked cookies with the same bounded unauthenticated response", async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const teacherId = randomUUID();
    const expired = randomBytes(32).toString("base64url"); const revoked = randomBytes(32).toString("base64url");
    try {
      await pool.query("INSERT INTO teacher_account(teacher_id, email) VALUES ($1, $2)", [teacherId, "expired@example.edu"]);
      await pool.query(`INSERT INTO auth_session(session_id, token_hash, principal_kind, teacher_id, expires_at)
                        VALUES ($1, $2, 'teacher', $3, now() - interval '1 second')`, [randomUUID(), tokenHash(expired), teacherId]);
      await pool.query(`INSERT INTO auth_session(session_id, token_hash, principal_kind, teacher_id, expires_at, revoked_at)
                        VALUES ($1, $2, 'teacher', $3, now() + interval '8 hours', now())`, [randomUUID(), tokenHash(revoked), teacherId]);
    } finally { await pool.end(); }
    const app = await buildApp({ databaseUrl, config: { allowedOrigins: [allowedOrigin], publicBaseOrigin: allowedOrigin } });
    const request = (token?: string) => app.inject({ method: "GET", url: "/v1/auth/session", headers: { origin: allowedOrigin, ...(token ? { cookie: `lo_session=${token}` } : {}) } });
    const responses = await Promise.all([request(), request(expired), request(revoked)]);
    expect(responses.map((response) => [response.statusCode, response.body])).toEqual([
      [401, '{"code":"AUTH_REQUIRED"}'], [401, '{"code":"AUTH_REQUIRED"}'], [401, '{"code":"AUTH_REQUIRED"}'],
    ]);
    await app.close();
  });
});
