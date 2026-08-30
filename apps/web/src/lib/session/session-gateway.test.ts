import { describe, expect, it, vi } from "vitest";

import {
  FetchSessionGateway,
  SessionGatewayError,
  normalizeClassroomCode,
} from "./session-gateway.js";

const joined = {
  roomMemberId: "00000000-0000-4000-8000-000000000011",
  actorId: "00000000-0000-4000-8000-000000000012",
  pseudonym: "探索者 A",
};
const studentSession = {
  role: "student" as const,
  roomId: "00000000-0000-4000-8000-000000000010",
  ...joined,
  nova: {
    actorId: "00000000-0000-4000-8000-000000000013",
    actorKind: "agent" as const,
    actorRole: "socratic_facilitator" as const,
    displayName: "Nova Agent" as const,
  },
};

const teacherRoomList = {
  rooms: [{
    roomId: "00000000-0000-4000-8000-000000000020",
    topic: "生態系統探究",
    status: "scheduled" as const,
    durationSeconds: 2700 as const,
    startsAt: null,
    closesAt: null,
    createdAt: "2026-08-31T01:00:00.000Z",
  }],
  truncated: false,
};

const createdRoom = {
  room: {
    roomId: "00000000-0000-4000-8000-000000000020",
    roomCode: "ABC234",
    status: "scheduled" as const,
    durationSeconds: 2700 as const,
    nova: studentSession.nova,
  },
  seatInvites: ["A", "B", "C", "D"].map((letter, index) => ({
    roomMemberId: `00000000-0000-4000-8000-00000000003${index}`,
    actorId: `00000000-0000-4000-8000-00000000004${index}`,
    pseudonym: `探索者 ${letter}`,
    code: `ABC234567${index + 2}`,
  })),
};

const roomDetails = {
  roomId: createdRoom.room.roomId,
  topic: "生態系統探究",
  status: "scheduled" as const,
  durationSeconds: 2700 as const,
  startsAt: null,
  closesAt: null,
  nova: studentSession.nova,
  participants: ["A", "B", "C", "D"].map((letter, index) => ({
    actorId: `00000000-0000-4000-8000-00000000004${index}`,
    pseudonym: `探索者 ${letter}`,
    actorKind: "human" as const,
    actorRole: "student" as const,
  })),
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

describe("typed SessionGateway", () => {
  it("normalizes classroom codes without persisting them", () => {
    expect(normalizeClassroomCode(" ab c-23\n")).toBe("ABC-23");
  });

  it("joins through the canonical route then rehydrates server identity before returning", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(joined))
      .mockResolvedValueOnce(json(studentSession));
    const gateway = new FetchSessionGateway({ fetch });
    await expect(gateway.joinStudent({ roomCode: " abc 234 ", seatCode: " def 234 5678 " }))
      .resolves.toEqual(studentSession);
    expect(fetch).toHaveBeenNthCalledWith(1, "/v1/rooms/join", expect.objectContaining({
      method: "POST",
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify({ roomCode: "ABC234", seatCode: "DEF2345678" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, "/v1/auth/session", expect.objectContaining({
      method: "GET",
      credentials: "include",
      cache: "no-store",
    }));
  });

  it("fails closed when the post-join session identity disagrees", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(joined))
      .mockResolvedValueOnce(json({ ...studentSession, actorId: "00000000-0000-4000-8000-000000000099" }));
    await expect(new FetchSessionGateway({ fetch }).joinStudent({
      roomCode: "ABC234",
      seatCode: "DEF2345678",
    })).rejects.toThrow("SESSION_IDENTITY_MISMATCH");
  });

  it("parses only endpoint-legal errors and generated success responses", async () => {
    const unauthorized = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "AUTH_REQUIRED" }, 401)) });
    await expect(unauthorized.getSession()).rejects.toEqual(new SessionGatewayError("AUTH_REQUIRED"));

    const unknown = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "UNKNOWN" }, 401)) });
    await expect(unknown.getSession()).rejects.toThrow("SESSION_RESPONSE_INVALID");

    const wrongStatus = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "JOIN_FORBIDDEN" }, 401)) });
    await expect(wrongStatus.joinStudent({ roomCode: "ABC234", seatCode: "DEF2345678" }))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("sends normalized teacher email but exposes only the generic accepted result", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ accepted: true }, 202));
    await expect(new FetchSessionGateway({ fetch }).requestTeacherMagicLink({ email: " Teacher@Example.EDU " }))
      .resolves.toEqual({ accepted: true });
    expect(fetch).toHaveBeenCalledWith("/v1/auth/teacher/magic-link", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ email: "teacher@example.edu" }),
    }));

    const limited = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "RATE_LIMITED" }, 429)) });
    await expect(limited.requestTeacherMagicLink({ email: "teacher@example.edu" }))
      .rejects.toEqual(new SessionGatewayError("RATE_LIMITED"));
    const mismatched = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "ROOM_NOT_FOUND" }, 429)) });
    await expect(mismatched.requestTeacherMagicLink({ email: "teacher@example.edu" }))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
    const extra = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ statusCode: 429, code: "RATE_LIMITED" }, 429)) });
    await expect(extra.requestTeacherMagicLink({ email: "teacher@example.edu" }))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("requires a real 204 logout and never serializes transport details", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(new FetchSessionGateway({ fetch }).logout()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("/v1/auth/session", expect.objectContaining({
      method: "DELETE",
      credentials: "include",
    }));
    const failed = new FetchSessionGateway({ fetch: vi.fn().mockRejectedValue(new Error("cookie=secret")) });
    await expect(failed.getSession()).rejects.toThrow("SESSION_NETWORK_FAILURE");
  });

  it("lists only generated teacher room summaries through the canonical route", async () => {
    const fetch = vi.fn().mockResolvedValue(json(teacherRoomList));
    await expect(new FetchSessionGateway({ fetch }).getTeacherRooms()).resolves.toEqual(teacherRoomList);
    expect(fetch).toHaveBeenCalledWith("/v1/teacher/rooms", expect.objectContaining({
      method: "GET",
      credentials: "include",
      cache: "no-store",
    }));

    const leaked = new FetchSessionGateway({
      fetch: vi.fn().mockResolvedValue(json({
        ...teacherRoomList,
        rooms: [{ ...teacherRoomList.rooms[0], roomCode: "ABC234" }],
      })),
    });
    await expect(leaked.getTeacherRooms()).rejects.toThrow("SESSION_RESPONSE_INVALID");

    for (const [status, code] of [[401, "AUTH_REQUIRED"], [404, "ROOM_NOT_FOUND"], [503, "ROOM_LIST_UNAVAILABLE"]] as const) {
      const legal = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code }, status)) });
      await expect(legal.getTeacherRooms()).rejects.toEqual(new SessionGatewayError(code));
    }
    for (const [status, code] of [[401, "ROOM_NOT_FOUND"], [404, "ROOM_LIST_UNAVAILABLE"], [503, "ROOM_NOT_FOUND"]] as const) {
      const illegal = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code }, status)) });
      await expect(illegal.getTeacherRooms()).rejects.toThrow("SESSION_RESPONSE_INVALID");
    }
  });

  it("creates a room with the generated request and preserves one-time invite codes only in the response", async () => {
    const fetch = vi.fn().mockResolvedValue(json(createdRoom, 201));
    await expect(new FetchSessionGateway({ fetch }).createRoom({ topic: " 生態系統探究 " })).resolves.toEqual(createdRoom);
    expect(fetch).toHaveBeenCalledWith("/v1/rooms", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ topic: "生態系統探究" }),
    }));
  });

  it("loads room details through the shared route and hides endpoint-illegal errors", async () => {
    const fetch = vi.fn().mockResolvedValue(json(roomDetails));
    await expect(new FetchSessionGateway({ fetch }).getRoom(createdRoom.room.roomId)).resolves.toEqual(roomDetails);
    expect(fetch).toHaveBeenCalledWith(`/v1/rooms/${createdRoom.room.roomId}`, expect.objectContaining({
      method: "GET",
      credentials: "include",
    }));

    const illegal = new FetchSessionGateway({
      fetch: vi.fn().mockResolvedValue(json({ code: "JOIN_FORBIDDEN" }, 404)),
    });
    await expect(illegal.getRoom(createdRoom.room.roomId)).rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("loads a generated, cursor-bound room event page through the canonical route", async () => {
    const page = { events: [], throughRoomSeq: 4, nextAfterSeq: 4 };
    const fetch = vi.fn().mockResolvedValue(json(page));
    await expect(new FetchSessionGateway({ fetch }).getRoomEvents(createdRoom.room.roomId, 4, 50))
      .resolves.toEqual(page);
    expect(fetch).toHaveBeenCalledWith(`/v1/rooms/${createdRoom.room.roomId}/events?afterSeq=4&limit=50`, expect.objectContaining({
      method: "GET",
      credentials: "include",
      cache: "no-store",
    }));

    const hidden = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "ROOM_NOT_FOUND" }, 404)) });
    await expect(hidden.getRoomEvents(createdRoom.room.roomId, 0))
      .rejects.toEqual(new SessionGatewayError("ROOM_NOT_FOUND"));
    const leakedForbidden = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "FORBIDDEN" }, 403)) });
    await expect(leakedForbidden.getRoomEvents(createdRoom.room.roomId, 0))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
    const invalid = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ ...page, secret: true })) });
    await expect(invalid.getRoomEvents(createdRoom.room.roomId, 4)).rejects.toThrow("SESSION_RESPONSE_INVALID");
  });
});
