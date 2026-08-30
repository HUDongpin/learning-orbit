import { describe, expect, it, vi } from "vitest";

import { enforceBackpressure } from "../../src/modules/realtime/backpressure.js";

describe("bounded realtime backpressure", () => {
  it.each([
    [0, "ok"], [255_999, "ok"], [256_000, "warn"], [999_999, "warn"],
  ] as const)("classifies bufferedAmount=%d as %s", (bufferedAmount, expected) => {
    const socket = { bufferedAmount, close: vi.fn() } as unknown as WebSocket;
    expect(enforceBackpressure(socket)).toBe(expected);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("closes a saturated socket with a recoverable code", () => {
    const socket = { bufferedAmount: 1_000_000, close: vi.fn() } as unknown as WebSocket;
    expect(enforceBackpressure(socket)).toBe("close");
    expect(socket.close).toHaveBeenCalledWith(1013, "snapshot required");
  });
});
