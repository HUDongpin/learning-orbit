import { describe, expect, it, vi } from "vitest";
import { ProjectionOutboxRepository } from "../../src/modules/analytics/projection-outbox-repository.js";

const roomId = "00000000-0000-4000-8000-000000000010";
const epoch = "00000000-0000-4000-8000-000000000011";

describe("analytics projection outbox", () => {
  it("claims and validates a pointer without exposing its payload", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{
      projection_outbox_id: "7", room_id: roomId,
      projection_key: "trace.student_bundle", analysis_epoch: epoch,
      projection_version: "5", complete_through_room_seq: "12",
      snapshot_url: `/v1/rooms/${roomId}/analytics/trace.student_bundle/latest`,
    }] }) } as any;
    const repository = new ProjectionOutboxRepository(pool);
    await expect(repository.claim(10, "publisher-1")).resolves.toEqual([{
      projectionOutboxId: 7, roomId, projectionKey: "trace.student_bundle",
      analysisEpoch: epoch, projectionVersion: 5, completeThroughRoomSeq: 12,
      snapshotUrl: `/v1/rooms/${roomId}/analytics/trace.student_bundle/latest`,
    }]);
  });

  it("fails closed on a corrupt pointer row", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{
      projection_outbox_id: "7", room_id: roomId,
      projection_key: "trace.student_bundle", analysis_epoch: epoch,
      projection_version: "5.5", complete_through_room_seq: "12",
      snapshot_url: "/v1/rooms/x/latest",
    }] }) } as any;
    await expect(new ProjectionOutboxRepository(pool).claim(1, "publisher-1"))
      .rejects.toThrow("ANALYTICS_OUTBOX_CORRUPT");
  });

  it("requires the claim owner when marking a pointer published", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: 0 }) } as any;
    await expect(new ProjectionOutboxRepository(pool).markPublished(7, "publisher-1"))
      .rejects.toThrow("ANALYTICS_OUTBOX_CLAIM_STALE");
  });
});
