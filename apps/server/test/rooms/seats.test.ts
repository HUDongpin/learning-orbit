import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { roomHttpContract } from "@learning-orbit/contracts";
import { buildApp } from "../../src/app.js";
import { tokenHash } from "../../src/modules/auth/crypto.js";
import type { RoomCodeSource } from "../../src/modules/rooms/room-service.js";
import { CodeHasher } from "../../src/modules/rooms/seat-codes.js";
import { resetBusinessTables } from "../db/reset.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for room seat tests");

const allowedOrigin = "https://app.learning-orbit.test";
const pepperV1 = Buffer.alloc(32, 0x61);
const pepperV2 = Buffer.alloc(32, 0x62);
const pseudonyms = ["探索者 A", "探索者 B", "探索者 C", "探索者 D"];
const apps: FastifyInstance[] = [];

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

function hasherV1(): CodeHasher {
  return new CodeHasher(1, new Map([[1, pepperV1]]));
}

function hasherV2(): CodeHasher {
  return new CodeHasher(2, new Map([[1, pepperV1], [2, pepperV2]]));
}

async function appWith(
  hasher: CodeHasher,
  roomCodeSource?: RoomCodeSource,
): Promise<FastifyInstance> {
  const app = await buildApp({
    databaseUrl,
    codeHasher: hasher,
    ...(roomCodeSource ? { roomCodeSource } : {}),
    config: { allowedOrigins: [allowedOrigin], publicBaseOrigin: allowedOrigin },
  });
  apps.push(app);
  return app;
}

async function query<T extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    return (await pool.query<T>(text, [...values])).rows;
  } finally {
    await pool.end();
  }
}

async function seedTeacher(email = `${randomUUID()}@example.edu`): Promise<{
  teacherId: string;
  token: string;
}> {
  const teacherId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  await query(
    `WITH teacher AS (
       INSERT INTO teacher_account(teacher_id, email) VALUES ($1, $2)
     )
     INSERT INTO auth_session(
       session_id, token_hash, principal_kind, teacher_id, expires_at
     ) VALUES ($3, $4, 'teacher', $1, now() + interval '8 hours')`,
    [teacherId, email, randomUUID(), tokenHash(token)],
  );
  return { teacherId, token };
}

function headers(token?: string): Record<string, string> {
  return {
    origin: allowedOrigin,
    ...(token ? { cookie: `lo_session=${token}` } : {}),
  };
}

function cookieToken(response: InjectResponse): string {
  const value = response.headers["set-cookie"];
  const line = Array.isArray(value) ? value[0] : value;
  if (typeof line !== "string") throw new Error("EXPECTED_SESSION_COOKIE");
  const match = /^lo_session=([^;]+)/.exec(line);
  if (!match?.[1]) throw new Error("EXPECTED_SESSION_COOKIE");
  return match[1];
}

async function createRoom(app: FastifyInstance, teacherToken: string, topic = "生態系統") {
  const response = await app.inject({
    method: "POST", url: "/v1/rooms", payload: { topic }, headers: headers(teacherToken),
  });
  expect(response.statusCode).toBe(201);
  return roomHttpContract.parseCreateRoomResponse(response.json());
}

async function join(
  app: FastifyInstance,
  roomCode: string,
  seatCode: string,
): Promise<InjectResponse> {
  return app.inject({
    method: "POST", url: "/v1/rooms/join", payload: { roomCode, seatCode }, headers: headers(),
  });
}

async function businessRowCount(): Promise<number> {
  const rows = await query<{ count: number }>(
    `SELECT (
      (SELECT count(*) FROM teacher_account)
      + (SELECT count(*) FROM magic_link)
      + (SELECT count(*) FROM classroom_room)
      + (SELECT count(*) FROM room_member)
      + (SELECT count(*) FROM auth_session)
      + (SELECT count(*) FROM room_event)
      + (SELECT count(*) FROM outbox_event)
      + (SELECT count(*) FROM worker_job)
      + (SELECT count(*) FROM worker_job_completion)
    )::int AS count`,
  );
  return rows[0]?.count ?? -1;
}

beforeEach(async () => {
  await resetBusinessTables(databaseUrl);
  expect(await businessRowCount()).toBe(0);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await resetBusinessTables(databaseUrl);
  expect(await businessRowCount()).toBe(0);
  vi.restoreAllMocks();
});

describe("four pseudonymous room seats", () => {
  it("requires a teacher, trims the topic, and stores four unique opaque invites", async () => {
    const app = await appWith(hasherV1());
    const unauthenticated = await app.inject({
      method: "POST", url: "/v1/rooms", payload: { topic: "生態系統" }, headers: headers(),
    });
    expect([unauthenticated.statusCode, unauthenticated.body]).toEqual([
      401, '{"code":"AUTH_REQUIRED"}',
    ]);
    const teacher = await seedTeacher();
    const made = await createRoom(app, teacher.token, "  生態系統  ");

    expect(made.seatInvites.map(({ pseudonym }) => pseudonym)).toEqual(pseudonyms);
    expect(new Set(made.seatInvites.map(({ code }) => code)).size).toBe(4);
    expect(made.room.roomCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(made.seatInvites.every(({ code }) => (
      /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/.test(code)
    ))).toBe(true);

    const rows = await query<{
      room_hash: Buffer;
      member_hash: Buffer;
      nova_actor_id: string;
      actor_id: string;
      topic: string;
    }>(
      `SELECT r.room_code_hash AS room_hash, m.code_hash AS member_hash,
              r.nova_actor_id, m.actor_id, r.topic
       FROM classroom_room r
       JOIN room_member m ON m.room_id = r.room_id
       ORDER BY m.seat_index`,
    );
    expect(rows).toHaveLength(4);
    expect(rows.every(({ room_hash, member_hash }) => (
      room_hash.length === 34 && member_hash.length === 34
      && room_hash.readUInt16BE(0) === 1 && member_hash.readUInt16BE(0) === 1
    ))).toBe(true);
    expect(rows.map(({ topic }) => topic)).toEqual(Array.from({ length: 4 }, () => "生態系統"));
    const publicSecrets = [made.room.roomCode, ...made.seatInvites.map(({ code }) => code)];
    expect(JSON.stringify(rows)).not.toContain(publicSecrets[0]);
    for (const secret of publicSecrets.slice(1)) expect(JSON.stringify(rows)).not.toContain(secret);
    expect(new Set([
      ...rows.map(({ nova_actor_id }) => nova_actor_id),
      ...rows.map(({ actor_id }) => actor_id),
    ]).size).toBe(5);

    const joined = await join(app, made.room.roomCode, made.seatInvites[0].code);
    const studentCookie = cookieToken(joined);
    const studentCreate = await app.inject({
      method: "POST", url: "/v1/rooms", payload: { topic: "不允許" }, headers: headers(studentCookie),
    });
    expect([studentCreate.statusCode, studentCreate.body]).toEqual([
      403, '{"code":"ROOM_FORBIDDEN"}',
    ]);
  });

  it("rejects malformed input before HMAC work and keeps every valid bad pair indistinguishable", async () => {
    const hasher = hasherV1();
    const candidateSpy = vi.spyOn(hasher, "candidateHashes");
    const verifySpy = vi.spyOn(hasher, "verify");
    const app = await appWith(hasher);
    const teacher = await seedTeacher();
    const first = await createRoom(app, teacher.token);
    const second = await createRoom(app, teacher.token, "食物網");
    candidateSpy.mockClear();
    verifySpy.mockClear();

    const malformed = [
      { roomCode: "SHORT", seatCode: "DEF567GHJK" },
      { roomCode: "ABC23I", seatCode: "DEF567GHJK" },
      { roomCode: "abc234", seatCode: "DEF567GHJK" },
      { roomCode: "ABC234", seatCode: "TOO-SHORT" },
      { roomCode: "ABC234", seatCode: "DEF567GHJK", extra: true },
    ];
    for (const payload of malformed) {
      const response = await app.inject({
        method: "POST", url: "/v1/rooms/join", payload, headers: headers(),
      });
      expect([response.statusCode, response.headers["set-cookie"]]).toEqual([400, undefined]);
    }
    expect(candidateSpy).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();

    await query("UPDATE classroom_room SET status = 'closed' WHERE room_id = $1", [second.room.roomId]);
    const changed = (value: string) => `${value[0] === "Z" ? "Y" : "Z"}${value.slice(1)}`;
    const attempts = [
      [first.room.roomCode, changed(first.seatInvites[0].code)],
      [changed(first.room.roomCode), first.seatInvites[0].code],
      [first.room.roomCode, second.seatInvites[0].code],
      [second.room.roomCode, second.seatInvites[0].code],
    ] as const;
    const responses = [];
    for (const [roomCode, seatCode] of attempts) responses.push(await join(app, roomCode, seatCode));
    expect(responses.map(({ statusCode, body }) => [statusCode, body])).toEqual(
      attempts.map(() => [403, '{"code":"JOIN_FORBIDDEN"}']),
    );
    expect(responses.every((response) => response.headers["set-cookie"] === undefined)).toBe(true);
  });

  it("equalizes valid unknown-room and existing wrong-seat HMAC comparison paths", async () => {
    const hasher = hasherV1();
    const verifySpy = vi.spyOn(hasher, "verify");
    const app = await appWith(hasher);
    const teacher = await seedTeacher();
    const made = await createRoom(app, teacher.token);
    const changed = (value: string) => `${value[0] === "Z" ? "Y" : "Z"}${value.slice(1)}`;

    verifySpy.mockClear();
    const unknown = await join(app, changed(made.room.roomCode), made.seatInvites[0].code);
    const unknownVerifyCount = verifySpy.mock.calls.length;
    verifySpy.mockClear();
    const wrongSeat = await join(app, made.room.roomCode, changed(made.seatInvites[0].code));
    const existingVerifyCount = verifySpy.mock.calls.length;

    expect([unknown.statusCode, unknown.body]).toEqual([403, '{"code":"JOIN_FORBIDDEN"}']);
    expect([wrongSeat.statusCode, wrongSeat.body]).toEqual([403, '{"code":"JOIN_FORBIDDEN"}']);
    expect([unknownVerifyCount, existingVerifyCount]).toEqual([4, 4]);
  });

  it("rotates an eight-hour student session atomically and compares all four seats", async () => {
    const hasher = hasherV1();
    const verifySpy = vi.spyOn(hasher, "verify");
    const app = await appWith(hasher);
    const teacher = await seedTeacher();
    const made = await createRoom(app, teacher.token);
    verifySpy.mockClear();

    const first = await join(app, made.room.roomCode, made.seatInvites[0].code);
    expect(first.statusCode).toBe(200);
    expect(verifySpy).toHaveBeenCalledTimes(4);
    const firstBody = roomHttpContract.parseJoinRoomResponse(first.json());
    expect(firstBody).toEqual({
      roomMemberId: made.seatInvites[0].roomMemberId,
      actorId: made.seatInvites[0].actorId,
      pseudonym: "探索者 A",
    });
    expect(Object.hasOwn(firstBody, "roomId")).toBe(false);
    const oldToken = cookieToken(first);
    expect(first.headers["set-cookie"]).toContain("HttpOnly");
    expect(first.headers["set-cookie"]).toContain("Secure");
    expect(first.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(first.headers["set-cookie"]).toContain("Path=/");

    const second = await join(app, made.room.roomCode, made.seatInvites[0].code);
    const newToken = cookieToken(second);
    expect(newToken).not.toBe(oldToken);
    const oldSession = await app.inject({
      method: "GET", url: "/v1/auth/session", headers: headers(oldToken),
    });
    const newSession = await app.inject({
      method: "GET", url: "/v1/auth/session", headers: headers(newToken),
    });
    expect(oldSession.statusCode).toBe(401);
    expect(newSession.json()).toMatchObject({ role: "student", pseudonym: "探索者 A" });
    const active = await query<{ count: number; hours: number }>(
      `SELECT count(*)::int AS count,
              min(extract(epoch FROM (expires_at - created_at)) / 3600)::float AS hours
       FROM auth_session
       WHERE room_member_id = $1 AND revoked_at IS NULL`,
      [made.seatInvites[0].roomMemberId],
    );
    expect(active[0]?.count).toBe(1);
    expect(active[0]?.hours).toBeCloseTo(8, 6);
    const hashes = await query<{ token_hash: Buffer; revoked_at: Date | null }>(
      `SELECT token_hash, revoked_at FROM auth_session
       WHERE room_member_id = $1 ORDER BY created_at`,
      [made.seatInvites[0].roomMemberId],
    );
    expect(hashes).toHaveLength(2);
    expect(hashes[0]?.token_hash.equals(tokenHash(oldToken))).toBe(true);
    expect(hashes[0]?.revoked_at).toBeInstanceOf(Date);
    expect(hashes[1]?.token_hash.equals(tokenHash(newToken))).toBe(true);
    expect(hashes[1]?.revoked_at).toBeNull();
  });

  it("serializes concurrent joins so one seat has at most one active session", async () => {
    const app = await appWith(hasherV1());
    const teacher = await seedTeacher();
    const made = await createRoom(app, teacher.token);

    const responses = await Promise.all(Array.from(
      { length: 6 },
      () => join(app, made.room.roomCode, made.seatInvites[1].code),
    ));
    expect(responses.every(({ statusCode }) => statusCode === 200)).toBe(true);
    expect(new Set(responses.map(cookieToken)).size).toBe(6);
    const active = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM auth_session
       WHERE room_member_id = $1 AND revoked_at IS NULL`,
      [made.seatInvites[1].roomMemberId],
    );
    expect(active[0]?.count).toBe(1);
  });

  it("allows scheduled and open joins while paused and closed rooms stay forbidden", async () => {
    const app = await appWith(hasherV1());
    const teacher = await seedTeacher();
    const made = await createRoom(app, teacher.token);
    expect((await join(app, made.room.roomCode, made.seatInvites[0].code)).statusCode).toBe(200);
    await query("UPDATE classroom_room SET status = 'open' WHERE room_id = $1", [made.room.roomId]);
    expect((await join(app, made.room.roomCode, made.seatInvites[1].code)).statusCode).toBe(200);
    await query("UPDATE classroom_room SET status = 'paused' WHERE room_id = $1", [made.room.roomId]);
    expect((await join(app, made.room.roomCode, made.seatInvites[2].code)).statusCode).toBe(403);
    await query("UPDATE classroom_room SET status = 'closed' WHERE room_id = $1", [made.room.roomId]);
    expect((await join(app, made.room.roomCode, made.seatInvites[3].code)).statusCode).toBe(403);
  });

  it("counts only failed joins in the normalized 10-per-10-minute IP bucket", async () => {
    const app = await appWith(hasherV1());
    const teacher = await seedTeacher();
    const made = await createRoom(app, teacher.token);
    for (const origin of [undefined, "https://wrong.learning-orbit.test"] as const) {
      const rejected = await app.inject({
        method: "POST", url: "/v1/rooms/join",
        payload: { roomCode: made.room.roomCode, seatCode: made.seatInvites[0].code },
        headers: origin ? { origin } : {},
      });
      expect([rejected.statusCode, rejected.body, rejected.headers["set-cookie"]]).toEqual([
        403, '{"code":"ORIGIN_FORBIDDEN"}', undefined,
      ]);
    }
    for (let index = 0; index < 12; index += 1) {
      expect((await join(app, made.room.roomCode, made.seatInvites[0].code)).statusCode).toBe(200);
    }

    const wrongSeat = `${made.seatInvites[1].code[0] === "Z" ? "Y" : "Z"}${made.seatInvites[1].code.slice(1)}`;
    for (let index = 0; index < 10; index += 1) {
      const failed = await join(app, made.room.roomCode, wrongSeat);
      expect([failed.statusCode, failed.body, failed.headers["set-cookie"]]).toEqual([
        403, '{"code":"JOIN_FORBIDDEN"}', undefined,
      ]);
    }
    const limited = await join(app, made.room.roomCode, wrongSeat);
    expect([limited.statusCode, limited.body, limited.headers["set-cookie"]]).toEqual([
      429, '{"code":"RATE_LIMITED"}', undefined,
    ]);

    const malformedHasher = hasherV1();
    const malformedCandidates = vi.spyOn(malformedHasher, "candidateHashes");
    const malformedApp = await appWith(malformedHasher);
    for (let index = 0; index < 10; index += 1) {
      const malformed = await malformedApp.inject({
        method: "POST", url: "/v1/rooms/join",
        payload: { roomCode: "ABC23I", seatCode: "DEF567GHJK" }, headers: headers(),
      });
      expect(malformed.statusCode).toBe(400);
    }
    const malformedLimited = await malformedApp.inject({
      method: "POST", url: "/v1/rooms/join",
      payload: { roomCode: "ABC23I", seatCode: "DEF567GHJK" }, headers: headers(),
    });
    expect([malformedLimited.statusCode, malformedLimited.body]).toEqual([
      429, '{"code":"RATE_LIMITED"}',
    ]);
    expect(malformedCandidates).not.toHaveBeenCalled();
  });

  it("reads old pepper rows after rotation and writes all new rows with v2", async () => {
    const v1App = await appWith(hasherV1());
    const teacher = await seedTeacher();
    const oldRoom = await createRoom(v1App, teacher.token, "舊房間");
    const v2App = await appWith(hasherV2());

    expect((await join(v2App, oldRoom.room.roomCode, oldRoom.seatInvites[2].code)).statusCode)
      .toBe(200);
    const newRoom = await createRoom(v2App, teacher.token, "新房間");
    const versions = await query<{ room_version: number; seat_versions: number[] }>(
      `SELECT get_byte(r.room_code_hash, 0) * 256 + get_byte(r.room_code_hash, 1) AS room_version,
              array_agg(get_byte(m.code_hash, 0) * 256 + get_byte(m.code_hash, 1)
                        ORDER BY m.seat_index)::int[] AS seat_versions
       FROM classroom_room r JOIN room_member m ON m.room_id = r.room_id
       WHERE r.room_id = $1 GROUP BY r.room_id`,
      [newRoom.room.roomId],
    );
    expect(versions[0]).toEqual({ room_version: 2, seat_versions: [2, 2, 2, 2] });
  });

  it("does not reissue an old raw room code when the current pepper version changes", async () => {
    const firstSeats = ["ABC234DEFG", "BCD345EFGH", "CDE456FGHJ", "DEF567GHJK"];
    const secondSeats = ["EFG678HJKL", "FGH789JKLM", "GHJ892KLMN", "HJK923LMNP"];
    const v1App = await appWith(hasherV1(), {
      roomCode: () => "ABC234",
      seatCode: () => firstSeats.shift() ?? "JKL234MNPQ",
    });
    const teacher = await seedTeacher();
    expect((await createRoom(v1App, teacher.token, "v1")).room.roomCode).toBe("ABC234");

    const roomCodes = ["ABC234", "BCD345"];
    const v2App = await appWith(hasherV2(), {
      roomCode: () => roomCodes.shift() ?? "BCD345",
      seatCode: () => secondSeats.shift() ?? "KLM345NPQR",
    });
    expect((await createRoom(v2App, teacher.token, "v2")).room.roomCode).toBe("BCD345");
  });

  it("serializes v1 and v2 writers allocating the same raw room code", async () => {
    const completeReadSet = new Map([[1, pepperV1], [2, pepperV2]]);
    const v1Seats = ["ABC234DEFG", "BCD345EFGH", "CDE456FGHJ", "DEF567GHJK"];
    const v2Seats = ["EFG678HJKL", "FGH789JKLM", "GHJ892KLMN", "HJK923LMNP"];
    const v1RoomCodes = ["ABC234", "BCD345"];
    const v2RoomCodes = ["ABC234", "CDE456"];
    const v1App = await appWith(new CodeHasher(1, completeReadSet), {
      roomCode: () => v1RoomCodes.shift() ?? "BCD345",
      seatCode: () => v1Seats.shift() ?? "JKL234MNPQ",
    });
    const v2App = await appWith(new CodeHasher(2, completeReadSet), {
      roomCode: () => v2RoomCodes.shift() ?? "CDE456",
      seatCode: () => v2Seats.shift() ?? "KLM345NPQR",
    });
    const [firstTeacher, secondTeacher] = await Promise.all([
      seedTeacher(), seedTeacher(),
    ]);

    await query(
      `CREATE OR REPLACE FUNCTION learning_orbit_test_delay_room_insert()
       RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         PERFORM pg_sleep(0.2);
         RETURN NEW;
       END
       $$`,
    );
    await query(
      `CREATE TRIGGER learning_orbit_test_delay_room_insert
       BEFORE INSERT ON classroom_room
       FOR EACH ROW EXECUTE FUNCTION learning_orbit_test_delay_room_insert()`,
    );
    let responses: InjectResponse[];
    try {
      responses = await Promise.all([
        v1App.inject({
          method: "POST", url: "/v1/rooms", payload: { topic: "v1 writer" },
          headers: headers(firstTeacher.token),
        }),
        v2App.inject({
          method: "POST", url: "/v1/rooms", payload: { topic: "v2 writer" },
          headers: headers(secondTeacher.token),
        }),
      ]);
    } finally {
      await query("DROP TRIGGER IF EXISTS learning_orbit_test_delay_room_insert ON classroom_room");
      await query("DROP FUNCTION IF EXISTS learning_orbit_test_delay_room_insert()");
    }

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([201, 201]);
    const created = responses.map((response) => (
      roomHttpContract.parseCreateRoomResponse(response.json())
    ));
    expect(new Set(created.map(({ room }) => room.roomCode)).size).toBe(2);
    expect(created.map(({ room }) => room.roomCode)).toContain("ABC234");
  });

  it("retries a room-code collision and fails closed without a SQL error after bounded exhaustion", async () => {
    const roomCodes = ["ABC234", "ABC234", "BCD345", ...Array.from({ length: 8 }, () => "BCD345")];
    const seatCodes = [
      "ABC234DEFG", "BCD345EFGH", "CDE456FGHJ", "DEF567GHJK",
      "EFG678HJKL", "FGH789JKLM", "GHJ892KLMN", "HJK923LMNP",
    ];
    const source: RoomCodeSource = {
      roomCode: () => roomCodes.shift() ?? "BCD345",
      seatCode: () => seatCodes.shift() ?? "JKL234MNPQ",
    };
    const app = await appWith(hasherV1(), source);
    const teacher = await seedTeacher();
    const first = await createRoom(app, teacher.token, "第一房間");
    const second = await createRoom(app, teacher.token, "第二房間");
    expect([first.room.roomCode, second.room.roomCode]).toEqual(["ABC234", "BCD345"]);

    const exhausted = await app.inject({
      method: "POST", url: "/v1/rooms", payload: { topic: "第三房間" }, headers: headers(teacher.token),
    });
    expect([exhausted.statusCode, exhausted.body]).toEqual([
      503, '{"code":"ROOM_CODE_UNAVAILABLE"}',
    ]);
    expect(exhausted.body).not.toMatch(/duplicate|constraint|room_code_hash|SQL/i);
    expect((await query<{ count: number }>(
      "SELECT count(*)::int AS count FROM classroom_room",
    ))[0]?.count).toBe(2);
  });

  it("returns four students plus Nova only to the owning teacher or room student", async () => {
    const app = await appWith(hasherV1());
    const owner = await seedTeacher();
    const outsider = await seedTeacher();
    const first = await createRoom(app, owner.token);
    const second = await createRoom(app, outsider.token, "另一房間");
    const joined = await join(app, first.room.roomCode, first.seatInvites[0].code);
    const studentToken = cookieToken(joined);
    const otherJoined = await join(app, second.room.roomCode, second.seatInvites[0].code);
    const otherStudentToken = cookieToken(otherJoined);

    const noCookie = await app.inject({
      method: "GET", url: `/v1/rooms/${first.room.roomId}`, headers: headers(),
    });
    expect([noCookie.statusCode, noCookie.body]).toEqual([401, '{"code":"AUTH_REQUIRED"}']);

    for (const token of [owner.token, studentToken]) {
      const response = await app.inject({
        method: "GET", url: `/v1/rooms/${first.room.roomId}`, headers: headers(token),
      });
      expect(response.statusCode).toBe(200);
      const details = roomHttpContract.parseRoomDetails(response.json());
      expect(details.participants).toHaveLength(4);
      expect(details.participants.map(({ pseudonym }) => pseudonym)).toEqual(pseudonyms);
      expect(details.participants.every(({ actorKind, actorRole }) => (
        actorKind === "human" && actorRole === "student"
      ))).toBe(true);
      expect(details.nova).toEqual(first.room.nova);
      expect(response.body).not.toMatch(/roomCode|seatCode|code_hash|seatInvites/);
    }

    for (const [token, roomId] of [
      [outsider.token, first.room.roomId],
      [otherStudentToken, first.room.roomId],
      [owner.token, randomUUID()],
    ] as const) {
      const response = await app.inject({
        method: "GET", url: `/v1/rooms/${roomId}`, headers: headers(token),
      });
      expect([response.statusCode, response.body]).toEqual([404, '{"code":"ROOM_NOT_FOUND"}']);
    }
  });
});
