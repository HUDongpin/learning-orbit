import { describe, expect, it, vi } from "vitest";
import { OutboxPublisher } from "../../src/modules/realtime/outbox-publisher.js";

const roomId = "00000000-0000-4000-8000-000000000010";
const epoch = "00000000-0000-4000-8000-000000000011";
const pointer = {
  projectionOutboxId: 7,
  roomId,
  projectionKey: "trace.student_bundle",
  analysisEpoch: epoch,
  projectionVersion: 5,
  completeThroughRoomSeq: 12,
  snapshotUrl: `/v1/rooms/${roomId}/analytics/trace.student_bundle/latest`,
};

function publisher() {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn().mockResolvedValue({ rowCount: 1 }),
  } as any;
  const hub = { broadcastProjectionAuthorized: vi.fn().mockResolvedValue(1) } as any;
  const repository = {
    claim: vi.fn().mockResolvedValue([pointer]),
    markPublished: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  } as any;
  const authorize = vi.fn().mockResolvedValue({ allow: true });
  return { publisher: new OutboxPublisher(pool, hub, "projection-publisher", { repository, authorize }), pool, client, hub, repository, authorize };
}

describe("analytics projection pointer publisher", () => {
  it("sends a schema-valid pointer and marks it published", async () => {
    const value = publisher();
    await expect(value.publisher.tick(10)).resolves.toBe(1);
    expect(value.repository.claim).toHaveBeenCalledWith(10, "projection-publisher");
    expect(value.hub.broadcastProjectionAuthorized).toHaveBeenCalledWith(
      roomId,
      expect.objectContaining({ type: "projection", projectionKey: pointer.projectionKey }),
      value.authorize,
    );
    expect(value.repository.markPublished).toHaveBeenCalledWith(7, "projection-publisher");
    expect(value.repository.release).not.toHaveBeenCalled();
  });

  it("releases a pointer when frame delivery fails", async () => {
    const value = publisher();
    value.hub.broadcastProjectionAuthorized.mockRejectedValueOnce(new Error("temporary"));
    await expect(value.publisher.tick(1)).resolves.toBe(0);
    expect(value.repository.release).toHaveBeenCalledWith(7, "projection-publisher");
    expect(value.repository.markPublished).not.toHaveBeenCalled();
  });
});
