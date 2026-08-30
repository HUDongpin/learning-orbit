import { describe, expect, it } from "vitest";

import { isRoomId, roomPagePath } from "./room-route.js";

describe("browser room route boundary", () => {
  it("accepts only canonical UUID room identifiers", () => {
    const valid = "00000000-0000-4000-8000-000000000010";
    expect(isRoomId(valid)).toBe(true);
    for (const value of ["demo-room", "", `${valid}?role=teacher`, `${valid}#fragment`, "../teacher"]) {
      expect(isRoomId(value)).toBe(false);
    }
  });

  it("builds only canonical student and teacher page paths", () => {
    const roomId = "00000000-0000-4000-8000-000000000010";
    expect(roomPagePath(roomId, "student")).toBe(`/session/${roomId}`);
    expect(roomPagePath(roomId, "teacher")).toBe(`/session/${roomId}/teacher`);
    expect(() => roomPagePath("demo-room", "student")).toThrow("INVALID_ROOM_ID");
  });
});
