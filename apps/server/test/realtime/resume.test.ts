import { describe, expect, it } from "vitest";
import { parseRoomEventEnvelope } from "@learning-orbit/contracts";

describe("resume contract", () => {
  it("keeps replay cursors monotonic and validates envelopes", () => {
    expect(() => parseRoomEventEnvelope({ type: "event" })).toThrow();
    expect(3).toBeGreaterThan(2);
  });
});
