import { describe, expect, it, vi } from "vitest";
import { AnalyticsRepository } from "../../src/modules/analytics/analytics-repository.js";

const roomId = "00000000-0000-4000-8000-000000000010";
const epoch = "00000000-0000-4000-8000-000000000011";
const hash = "a".repeat(64);
const warningHash = "c2a5013e8ed1e1dbadee2ac7792faf436c75038cb014fa28f1aea5ee54484ce7";

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
    warnings: ["client_time_future_clamped"],
    warnings_sha256: warningHash,
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
    expect(result.baseSnapshot?.warnings).toEqual(["client_time_future_clamped"]);
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

  it("restores an empty student ECHO as unreviewed and treats every TRACE patch request as snapshot-only", async () => {
    const studentRow = {
      ...baseSnapshotRow(),
      projection_key: "echo.student_approved",
    };
    const studentRepository = new AnalyticsRepository(fakePool([{ rows: [studentRow] }]));
    await expect(studentRepository.latest(roomId, "echo.student_approved"))
      .resolves.toMatchObject({
        reviewStatus: "unreviewed",
        displayStatus: "student_approved",
        warnings: ["client_time_future_clamped"],
      });

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

  it("fails closed instead of fabricating empty warnings for a corrupt snapshot row", async () => {
    const repository = new AnalyticsRepository(fakePool([{ rows: [{ ...baseSnapshotRow(), warnings: {} }] }]));
    await expect(repository.latest(roomId, "echo.teacher_shadow")).rejects.toThrow("ANALYTICS_CORRUPT");
    const wrongHash = new AnalyticsRepository(fakePool([{ rows: [{ ...baseSnapshotRow(), warnings_sha256: "0".repeat(64) }] }]));
    await expect(wrongHash.latest(roomId, "echo.teacher_shadow")).rejects.toThrow("ANALYTICS_CORRUPT");
  });

  it("writes warning bytes and their independent hash with an immutable snapshot", async () => {
    const snapshot = await new AnalyticsRepository(fakePool([{ rows: [baseSnapshotRow()] }]))
      .latest(roomId, "echo.teacher_shadow");
    expect(snapshot).not.toBeNull();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ snapshot_id: "00000000-0000-4000-8000-000000000801" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await AnalyticsRepository.persistProjection({ query } as never, {
      snapshot: snapshot!,
      snapshotUrl: `/v1/rooms/${roomId}/analytics/echo.teacher_shadow/latest`,
    });
    const [sql, parameters] = query.mock.calls[0]!;
    expect(sql).toContain("warnings,warnings_sha256,payload,content_sha256");
    expect(parameters[10]).toEqual(["client_time_future_clamped"]);
    expect(parameters[11]).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a conflicting preexisting snapshot before an orphan row can advance the head", async () => {
    const snapshot = await new AnalyticsRepository(fakePool([{ rows: [baseSnapshotRow()] }]))
      .latest(roomId, "echo.teacher_shadow");
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        complete_through_seq: "1",
        watermark_event_time: snapshot!.watermarkEventTime,
        requires_replay: false,
        algorithm_version: snapshot!.algorithmVersion,
        parameter_hash: snapshot!.parameterHash,
        warnings: ["different_warning"],
        warnings_sha256: "0".repeat(64),
        payload: snapshot!.payload,
        content_sha256: "0".repeat(64),
      }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(AnalyticsRepository.persistProjection({ query } as never, {
      snapshot: snapshot!,
      snapshotUrl: `/v1/rooms/${roomId}/analytics/echo.teacher_shadow/latest`,
    })).rejects.toThrow("ANALYTICS_CORRUPT");
    expect(query).toHaveBeenCalledTimes(2);
  });
});
