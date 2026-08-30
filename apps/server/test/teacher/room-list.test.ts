import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "@learning-orbit/contracts";
import { buildApp } from "../../src/app.js";
import {
  TeacherRoomListError,
  TeacherRoomListService,
} from "../../src/modules/teacher/teacher-room-list-service.js";

const teacher: AuthSession = {
  role: "teacher",
  teacherId: "00000000-0000-4000-8000-000000000001",
  actorId: "00000000-0000-4000-8000-000000000001",
};
const student: AuthSession = {
  role: "student",
  roomId: "00000000-0000-4000-8000-000000000010",
  roomMemberId: "00000000-0000-4000-8000-000000000011",
  actorId: "00000000-0000-4000-8000-000000000012",
  pseudonym: "探索者 A",
  nova: {
    actorId: "00000000-0000-4000-8000-000000000013",
    actorKind: "agent",
    actorRole: "socratic_facilitator",
    displayName: "Nova Agent",
  },
};

describe("teacher room-list service", () => {
  it("returns at most 50 redacted rooms and derives truncation from row 51", async () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({
      room_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      topic: `Topic ${index}`,
      status: index < 25 ? "open" as const : "closed" as const,
      duration_seconds: 2700,
      starts_at: index < 25 ? new Date("2026-08-31T01:00:00.000Z") : null,
      closes_at: index < 25 ? new Date("2026-08-31T01:45:00.000Z") : null,
      created_at: new Date(Date.UTC(2026, 7, 31, 0, 0, 51 - index)),
    }));
    const query = vi.fn(async () => ({ rows }));
    const service = new TeacherRoomListService({ query } as never);
    const result = await service.list(teacher);
    expect(result.rooms).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(Object.keys(result.rooms[0]!).sort()).toEqual([
      "closesAt", "createdAt", "durationSeconds", "roomId", "startsAt", "status", "topic",
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(
      /ORDER BY CASE WHEN status = 'closed' THEN 1 ELSE 0 END ASC, created_at DESC, room_id DESC\s+LIMIT 51/,
    ), [teacher.teacherId]);
  });

  it("hides the resource from students before querying", async () => {
    const query = vi.fn();
    const service = new TeacherRoomListService({ query } as never);
    await expect(service.list(student)).rejects.toEqual(new TeacherRoomListError("ROOM_NOT_FOUND"));
    expect(query).not.toHaveBeenCalled();
  });
});

describe("GET /v1/teacher/rooms", () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  const appFor = async (identity: AuthSession | null, list = vi.fn(async () => ({ rooms: [], truncated: false }))) => {
    const app = await buildApp({
      config: { allowedOrigins: ["https://app.learning-orbit.test"], publicBaseOrigin: "https://app.learning-orbit.test" },
      sessions: {
        get: async () => identity,
        getSessionId: async () => null,
        revoke: async () => undefined,
      } as never,
      teacherRooms: { list },
    });
    apps.push(app);
    return { app, list };
  };

  it("returns 401 anonymously, 404 to students, and generated JSON to teachers", async () => {
    const request = { headers: { origin: "https://app.learning-orbit.test" } };
    const anonymous = await appFor(null);
    const anonymousResponse = await anonymous.app.inject({ method: "GET", url: "/v1/teacher/rooms", ...request });
    expect(anonymousResponse.statusCode).toBe(401);
    const studentApp = await appFor(student);
    const hidden = await studentApp.app.inject({ method: "GET", url: "/v1/teacher/rooms", cookies: { lo_session: "opaque" }, ...request });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ code: "ROOM_NOT_FOUND" });
    const teacherApp = await appFor(teacher);
    const response = await teacherApp.app.inject({ method: "GET", url: "/v1/teacher/rooms", cookies: { lo_session: "opaque" }, ...request });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rooms: [], truncated: false });
    expect(teacherApp.list).toHaveBeenCalledWith(teacher);
    for (const result of [anonymousResponse, hidden, response]) {
      expect(result.headers["cache-control"]).toBe("no-store");
    }
  });

  it("maps service failures to one content-free 503", async () => {
    const { app } = await appFor(teacher, vi.fn(async () => { throw new Error("database host secret"); }));
    const response = await app.inject({ method: "GET", url: "/v1/teacher/rooms", cookies: { lo_session: "opaque" }, headers: { origin: "https://app.learning-orbit.test" } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "ROOM_LIST_UNAVAILABLE" });
    expect(response.body).not.toContain("database host secret");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects every unsupported query after role authorization and before data access", async () => {
    for (const suffix of ["?limit=50", "?teacherId=other", "?status=open", "?sort=createdAt", "?page=2", "?unknown=x"]) {
      const teacherApp = await appFor(teacher);
      const response = await teacherApp.app.inject({
        method: "GET",
        url: `/v1/teacher/rooms${suffix}`,
        cookies: { lo_session: "opaque" },
        headers: { origin: "https://app.learning-orbit.test" },
      });
      expect([response.statusCode, response.json()]).toEqual([400, { code: "INVALID_QUERY" }]);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(teacherApp.list).not.toHaveBeenCalled();
    }

    const anonymous = await appFor(null);
    const anonymousResponse = await anonymous.app.inject({
      method: "GET", url: "/v1/teacher/rooms?teacherId=other", headers: { origin: "https://app.learning-orbit.test" },
    });
    expect(anonymousResponse.statusCode).toBe(401);
    const studentApp = await appFor(student);
    const studentResponse = await studentApp.app.inject({
      method: "GET", url: "/v1/teacher/rooms?teacherId=other", cookies: { lo_session: "opaque" }, headers: { origin: "https://app.learning-orbit.test" },
    });
    expect(studentResponse.statusCode).toBe(404);
    expect(studentApp.list).not.toHaveBeenCalled();
  });
});
