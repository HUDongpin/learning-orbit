import { describe, expect, it } from "vitest";
import { EphemeralSignals } from "../../src/modules/realtime/ephemeral-signals.js";

const ACTOR = "00000000-0000-4000-8000-000000000001";
describe("ephemeral collaboration signals", () => {
  it("rejects stale client sequences and expires presence/typing", () => {
    const s = new EphemeralSignals();
    expect(s.acceptPresence(ACTOR, "active", 2, 1_000)?.state).toBe("active");
    expect(s.acceptPresence(ACTOR, "away", 1, 1_001)).toBeNull();
    expect(s.acceptTyping(ACTOR, true, 3, 1_000)?.active).toBe(true);
    expect(s.expire(31_001)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "presence" }),
      expect.objectContaining({ type: "typing", active: false }),
    ]));
  });
  it("disconnect cleanup emits non-persistent clear signals", () => {
    const s = new EphemeralSignals();
    s.acceptPresence(ACTOR, "active", 1, 0); s.acceptTyping(ACTOR, true, 2, 0);
    expect(s.remove(ACTOR, 100)).toEqual([
      { type: "presence", actorId: ACTOR, state: "away", expiresAt: new Date(100).toISOString() },
      { type: "typing", actorId: ACTOR, active: false, expiresAt: new Date(100).toISOString() },
    ]);
  });
});
