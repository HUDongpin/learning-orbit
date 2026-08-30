import { describe, expect, it } from "vitest";
import { createSessionState, sessionReducer } from "./session-store.js";

describe("session store", () => {
  it("keeps cursor monotonic and maps lifecycle status to pause state", () => {
    let state = createSessionState("room-1");
    state = sessionReducer(state, { type: "connection", connected: true });
    state = sessionReducer(state, { type: "status", status: "paused" });
    state = sessionReducer(state, { type: "cursor", roomSeq: 4 });
    state = sessionReducer(state, { type: "cursor", roomSeq: 2 });
    expect(state).toMatchObject({ connected: true, paused: true, status: "paused", lastRoomSeq: 4 });
  });
});
