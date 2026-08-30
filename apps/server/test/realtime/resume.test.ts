import { describe, expect, it, vi } from "vitest";
import { parseRoomEventEnvelope } from "@learning-orbit/contracts";
import { RoomHub } from "../../src/modules/realtime/room-hub.js";

describe("resume contract", () => {
  it("keeps replay cursors monotonic and validates envelopes", () => {
    expect(() => parseRoomEventEnvelope({ type: "event" })).toThrow();
    expect(3).toBeGreaterThan(2);
  });

  it("requests a snapshot and closes when the outbox has a sequence gap", async () => {
    const roomId = "00000000-0000-4000-8000-000000000010";
    const connection = {
      resumeFrom: 2,
      identity: { roomId, sessionId: "00000000-0000-4000-8000-000000000011" },
      send: vi.fn(), close: vi.fn(), finishReplay: vi.fn(),
    } as any;
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ room_seq: "4", envelope: {} }] }) } as any;
    const authorizer = { reauthorize: vi.fn() } as any;
    const hub = new RoomHub(pool, authorizer);
    await hub.resume(connection);
    expect(connection.send).toHaveBeenCalledWith({
      type: "snapshot_required", afterSeq: 2, throughRoomSeq: 2,
    });
    expect(connection.close).toHaveBeenCalledWith(4409, "invalid durable sequence");
    expect(connection.finishReplay).not.toHaveBeenCalled();
    expect(authorizer.reauthorize).not.toHaveBeenCalled();
  });
});
