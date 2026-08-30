import { describe, expect, it } from "vitest";

import {
  apiErrorContract,
  routes,
  teacherRoomListContract,
  type TeacherRoomListResponse,
} from "../src/index.js";

const room = {
  roomId: "00000000-0000-4000-8000-000000000001",
  topic: "生態系統探究",
  status: "open" as const,
  durationSeconds: 2700 as const,
  startsAt: "2026-08-31T01:00:00.000Z",
  closesAt: "2026-08-31T01:45:00.000Z",
  createdAt: "2026-08-31T00:55:00.000Z",
};

describe("teacher room recovery contract", () => {
  it("parses only the bounded redacted room-summary shape", () => {
    const response: TeacherRoomListResponse = { rooms: [room], truncated: false };
    expect(teacherRoomListContract.parse(response)).toEqual(response);
    expect(teacherRoomListContract.encode(response)).toBe(JSON.stringify(response));
    expect(() => teacherRoomListContract.parse({
      rooms: [{ ...room, roomCode: "SECRET" }],
      truncated: false,
    })).toThrow("INVALID_TEACHER_ROOM_LIST_RESPONSE");
    expect(teacherRoomListContract.parse({ rooms: [], truncated: false })).toEqual({ rooms: [], truncated: false });
    expect(teacherRoomListContract.parse({
      rooms: Array.from({ length: 50 }, (_, index) => ({
        ...room,
        roomId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
      truncated: true,
    }).rooms).toHaveLength(50);
    expect(() => teacherRoomListContract.parse({ rooms: [room], truncated: false, teacherEmail: "secret@example.edu" }))
      .toThrow("INVALID_TEACHER_ROOM_LIST_RESPONSE");
    expect(() => teacherRoomListContract.parse({ rooms: [{ ...room, createdAt: null }], truncated: false }))
      .toThrow("INVALID_TEACHER_ROOM_LIST_RESPONSE");
    expect(() => teacherRoomListContract.parse({ rooms: [{ ...room, durationSeconds: 60 }], truncated: false }))
      .toThrow("INVALID_TEACHER_ROOM_LIST_RESPONSE");
    expect(() => teacherRoomListContract.parse({
      rooms: Array.from({ length: 51 }, (_, index) => ({
        ...room,
        roomId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
      truncated: true,
    })).toThrow("INVALID_TEACHER_ROOM_LIST_RESPONSE");
  });

  it("owns one canonical teacher room-list route", () => {
    expect(routes.teacher.rooms()).toBe("/v1/teacher/rooms");
  });
});

describe("closed API error contract", () => {
  it("parses allowlisted codes and rejects extra or unknown fields", () => {
    expect(apiErrorContract.parse({ code: "AUTH_REQUIRED" })).toEqual({ code: "AUTH_REQUIRED" });
    expect(apiErrorContract.parse({ code: "ROOM_LIST_UNAVAILABLE" })).toEqual({ code: "ROOM_LIST_UNAVAILABLE" });
    expect(apiErrorContract.parse({ code: "INVALID_QUERY" })).toEqual({ code: "INVALID_QUERY" });
    expect(() => apiErrorContract.parse({ code: "SOMETHING_NEW" })).toThrow("INVALID_API_ERROR");
    expect(() => apiErrorContract.parse({ code: "AUTH_REQUIRED", detail: "leak" })).toThrow("INVALID_API_ERROR");
  });
});
