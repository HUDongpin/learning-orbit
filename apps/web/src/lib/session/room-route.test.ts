import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROOM_VIEW,
  isRoomId,
  parseRoomViewPreferences,
  roomPagePath,
  roomViewSearch,
} from "./room-route.js";

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

describe("room view preferences", () => {
  it("defaults anything it does not recognise instead of throwing", () => {
    expect(parseRoomViewPreferences(undefined)).toEqual(DEFAULT_ROOM_VIEW);
    expect(parseRoomViewPreferences("")).toEqual(DEFAULT_ROOM_VIEW);
    // A mistyped query must never be able to break the classroom.
    expect(parseRoomViewPreferences("?window=all_day&view=telepathic"))
      .toEqual(DEFAULT_ROOM_VIEW);
    expect(parseRoomViewPreferences("?window=session_45m&view=human_only"))
      .toEqual({ window: "session_45m", view: "human_only" });
    expect(parseRoomViewPreferences(new URLSearchParams({ view: "lineage_adjusted" })))
      .toEqual({ window: "recent_10m", view: "lineage_adjusted" });
  });

  it("keeps an untouched classroom's URL clean and round-trips a chosen view", () => {
    expect(roomViewSearch(DEFAULT_ROOM_VIEW)).toBe("");
    expect(roomViewSearch({ window: "session_45m", view: "observed" }))
      .toBe("window=session_45m");
    const search = roomViewSearch({ window: "session_45m", view: "human_only" });
    expect(search).toBe("view=human_only&window=session_45m");
    expect(parseRoomViewPreferences(search)).toEqual({ window: "session_45m", view: "human_only" });
  });

  it("preserves query keys it does not own", () => {
    const search = roomViewSearch({ window: "session_45m", view: "observed" }, "role=student");
    expect(parseRoomViewPreferences(search)).toEqual({ window: "session_45m", view: "observed" });
    expect(new URLSearchParams(search).get("role")).toBe("student");
    // Returning to the default removes only its own key.
    const cleared = roomViewSearch(DEFAULT_ROOM_VIEW, search);
    expect(cleared).toBe("role=student");
  });
});
