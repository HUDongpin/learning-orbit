import { describe, expect, it } from "vitest";
import { AnalyticsRepository } from "../../src/modules/analytics/analytics-repository.js";

const roomId = "00000000-0000-4000-8000-000000000010";
const epoch = "00000000-0000-4000-8000-000000000011";
const hash = "a".repeat(64);

function patchRow(version: number, baseVersion: number, requiresReplay = false) {
  return {
    room_id: roomId,
    projection_key: "echo.teacher_shadow",
    analysis_epoch: epoch,
    version: String(version),
    base_version: String(baseVersion),
    complete_through_seq: String(version),
    watermark_event_time: new Date("2026-08-30T12:00:00.000Z"),
    algorithm_version: "echo-v1",
    parameter_hash: hash,
    requires_replay: requiresReplay,
    payload: {
      requiresReplay,
      warnings: [], nodesAdded: [], nodesUpdated: [], nodesHidden: [],
      edgesAdded: [], edgesUpdated: [], edgesHidden: [], positionUpdates: [],
      changeScore: 0, reasonCodes: [], evidenceRefs: [],
    },
    created_at: new Date("2026-08-30T12:00:00.000Z"),
  };
}

function baseSnapshotRow() {
  return {
    room_id: roomId,
    projection_key: "echo.teacher_shadow",
    analysis_epoch: epoch,
    version: "1",
    base_version: "0",
    complete_through_seq: "1",
    watermark_event_time: new Date("2026-08-30T12:00:00.000Z"),
    algorithm_version: "echo-v1",
    parameter_hash: hash,
    requires_replay: false,
    payload: { nodes: [], edges: [] },
    created_at: new Date("2026-08-30T12:00:00.000Z"),
  };
}

function fakePool(rows: Array<{ rows: any[] }>) {
  let index = 0;
  return { query: async () => rows[index++] ?? { rows: [] } } as any;
}

describe("AnalyticsRepository projection chain", () => {
  it("reverses the bounded descending query and returns a contiguous timeline", async () => {
    const repository = new AnalyticsRepository(fakePool([
      { rows: [{ version: "3", analysis_epoch: epoch, algorithm_version: "echo-v1", parameter_hash: hash }] },
      { rows: [patchRow(3, 2), patchRow(2, 1)] },
      { rows: [baseSnapshotRow()] },
    ]));
    const result = await repository.timeline(roomId, "echo.teacher_shadow", epoch, 2);
    expect(result.kind).toBe("timeline");
    expect(result.patches.map((patch) => [patch.baseVersion, patch.version])).toEqual([[1, 2], [2, 3]]);
    expect(result.baseSnapshot?.version).toBe(1);
    expect(result.truncatedBeforeVersion).toBe(1);
    expect(result.headVersion).toBe(3);
  });

  it("returns resync instead of a partial or gapped timeline", async () => {
    const repository = new AnalyticsRepository(fakePool([
      { rows: [{ version: "3", analysis_epoch: epoch, algorithm_version: "echo-v1", parameter_hash: hash }] },
      { rows: [patchRow(3, 2)] },
    ]));
    const result = await repository.timeline(roomId, "echo.teacher_shadow", epoch, 2);
    expect(result.kind).toBe("resync");
    expect(result.patches).toEqual([]);
  });

  it("keeps requiresReplay on a patch and rejects a mismatched chain", async () => {
    const repository = new AnalyticsRepository(fakePool([
      { rows: [{ analysis_epoch: epoch, version: "1", algorithm_version: "echo-v1", parameter_hash: hash }] },
      { rows: [patchRow(1, 0, true)] },
    ]));
    const window = await repository.patchesAfter(roomId, "echo.teacher_shadow", epoch, 0, "/latest");
    expect(window.kind).toBe("patches");
    expect(window.patches?.[0]?.requiresReplay).toBe(true);
  });

  it("restores student ECHO as approved and treats every TRACE patch request as snapshot-only", async () => {
    const studentRow = {
      ...baseSnapshotRow(),
      projection_key: "echo.student_approved",
    };
    const studentRepository = new AnalyticsRepository(fakePool([{ rows: [studentRow] }]));
    await expect(studentRepository.latest(roomId, "echo.student_approved"))
      .resolves.toMatchObject({ reviewStatus: "approved", displayStatus: "student_approved" });

    const traceRepository = new AnalyticsRepository(fakePool([{
      rows: [{ analysis_epoch: epoch, version: "1", algorithm_version: "trace-v1", parameter_hash: hash }],
    }]));
    await expect(traceRepository.patchesAfter(
      roomId,
      "trace.student_bundle",
      epoch,
      1,
      `/v1/rooms/${roomId}/analytics/trace.student_bundle/latest`,
    )).resolves.toMatchObject({ kind: "resync" });
  });
});
