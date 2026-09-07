import { describe, expect, it, vi } from "vitest";

import {
  formatProjectionReadyStatus,
  ProjectionCoordinator,
  type CoherentBatch,
} from "./projection-coordinator.js";

const ledgerBatch = { kind: "ledger" };
const conceptBatch = { kind: "concept" };
const snaBatch = { kind: "sna" };

describe("projection coordinator", () => {
  it("publishes one coherent chat, concept and SNA batch", () => {
    const publish = vi.fn();
    const coordinator = new ProjectionCoordinator(publish);

    coordinator.stage("chatLedger", { projectionVersion: 41, completeThroughRoomSeq: 128, value: ledgerBatch });
    coordinator.stage("concept", { projectionVersion: 12, completeThroughRoomSeq: 128, value: conceptBatch });
    expect(publish).not.toHaveBeenCalled();

    // One surface a message behind is the whole point: a concept map built
    // from more of the conversation than the chat beside it is a claim the
    // transcript does not support yet.
    coordinator.stage("sna", { projectionVersion: 8, completeThroughRoomSeq: 127, value: snaBatch });
    expect(publish).not.toHaveBeenCalled();

    coordinator.stage("sna", { projectionVersion: 9, completeThroughRoomSeq: 128, value: snaBatch });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      status: "ready",
      completeThroughRoomSeq: 128,
      projectionVersions: { chatLedger: 41, concept: 12, sna: 9 },
    }));
    expect(formatProjectionReadyStatus(publish.mock.calls[0]![0] as CoherentBatch))
      .toBe("已同步至房間序號 128（聊天投影 41、概念投影 12、SNA 投影 9）");
  });

  it("keeps chat and an independently promoted panel ready without inventing a cursor", () => {
    const publish = vi.fn();
    const coordinator = new ProjectionCoordinator(publish);

    coordinator.setAvailability("sna", "not_available_by_policy");
    coordinator.stage("chatLedger", { projectionVersion: 42, completeThroughRoomSeq: 129, value: ledgerBatch });
    coordinator.stage("concept", { projectionVersion: 13, completeThroughRoomSeq: 129, value: conceptBatch });

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      status: "ready",
      unavailableByPolicy: ["sna"],
      projectionVersions: { chatLedger: 42, concept: 13 },
      sna: null,
    }));
    // A withheld surface is excluded from the agreement rather than given a
    // cursor it never had.
    expect(publish.mock.calls[0]![0].projectionVersions).not.toHaveProperty("sna");
  });

  it("waits again after a surface is promoted mid-session", () => {
    const publish = vi.fn();
    const coordinator = new ProjectionCoordinator(publish);
    coordinator.setAvailability("sna", "not_available_by_policy");
    coordinator.stage("chatLedger", { projectionVersion: 1, completeThroughRoomSeq: 10, value: ledgerBatch });
    coordinator.stage("concept", { projectionVersion: 1, completeThroughRoomSeq: 10, value: conceptBatch });
    expect(publish).toHaveBeenCalledTimes(1);

    coordinator.setAvailability("sna", "enabled");
    coordinator.stage("chatLedger", { projectionVersion: 2, completeThroughRoomSeq: 11, value: ledgerBatch });
    coordinator.stage("concept", { projectionVersion: 2, completeThroughRoomSeq: 11, value: conceptBatch });
    // The newly enabled surface has never staged, so nothing is coherent yet.
    expect(publish).toHaveBeenCalledTimes(1);

    coordinator.stage("sna", { projectionVersion: 1, completeThroughRoomSeq: 11, value: snaBatch });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]![0]).toMatchObject({
      completeThroughRoomSeq: 11,
      unavailableByPolicy: [],
    });
  });

  it("does not republish a cursor that has not moved", () => {
    const publish = vi.fn();
    const coordinator = new ProjectionCoordinator(publish);
    for (const surface of ["chatLedger", "concept", "sna"] as const) {
      coordinator.stage(surface, { projectionVersion: 1, completeThroughRoomSeq: 7, value: {} });
    }
    expect(publish).toHaveBeenCalledTimes(1);

    // A re-render is not new classroom activity.
    coordinator.stage("concept", { projectionVersion: 2, completeThroughRoomSeq: 7, value: {} });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("ignores a cursor or version that is not a real position", () => {
    const publish = vi.fn();
    const coordinator = new ProjectionCoordinator(publish);
    for (const projection of [
      { projectionVersion: -1, completeThroughRoomSeq: 5, value: {} },
      { projectionVersion: 1.5, completeThroughRoomSeq: 5, value: {} },
      { projectionVersion: 1, completeThroughRoomSeq: -5, value: {} },
      { projectionVersion: 1, completeThroughRoomSeq: Number.NaN, value: {} },
    ]) {
      coordinator.stage("chatLedger", projection);
    }
    coordinator.stage("concept", { projectionVersion: 1, completeThroughRoomSeq: 5, value: {} });
    coordinator.stage("sna", { projectionVersion: 1, completeThroughRoomSeq: 5, value: {} });
    // Chat never staged a usable position, so the batch is not coherent.
    expect(publish).not.toHaveBeenCalled();
    expect(coordinator.coherentCursor()).toBeUndefined();
  });

  it("says exactly what is on screen, including the withheld panel", () => {
    const publish = vi.fn();
    const coordinator = new ProjectionCoordinator(publish);
    coordinator.setAvailability("concept", "not_available_by_policy");
    coordinator.stage("chatLedger", { projectionVersion: 5, completeThroughRoomSeq: 20, value: {} });
    coordinator.stage("sna", { projectionVersion: 3, completeThroughRoomSeq: 20, value: {} });

    const batch = publish.mock.calls[0]![0] as CoherentBatch;
    expect(formatProjectionReadyStatus(batch)).toBe("已同步至房間序號 20（聊天投影 5、SNA 投影 3）");
    expect(batch.unavailableByPolicy).toEqual(["concept"]);
    expect(batch.concept).toBeNull();
  });
});
