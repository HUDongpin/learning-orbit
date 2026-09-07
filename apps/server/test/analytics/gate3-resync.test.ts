import { describe, expect, it } from "vitest";

import { AnalyticsRepository } from "../../src/modules/analytics/analytics-repository.js";
import { routes } from "@learning-orbit/contracts";

/**
 * Gate 3, point 11: a broken patch chain must resync to the snapshot and must
 * never hand back the prefix that happened to be intact.
 *
 * A prefix is the dangerous answer.  It parses, it is internally consistent,
 * and a client that applies it believes it is current while silently missing
 * every change after the break.  Refusing the whole window and pointing at the
 * snapshot is the only response that leaves the client no way to be quietly
 * wrong.
 */

const roomId = "00000000-0000-4000-8000-000000000010";
const epoch = "00000000-0000-4000-8000-000000000011";
const otherEpoch = "00000000-0000-4000-8000-000000000012";
const hash = "a".repeat(64);
const snapshotUrl = routes.analytics.latest(roomId, "echo.teacher_shadow");

function patchRow(version: number, baseVersion: number, override: Record<string, unknown> = {}) {
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
    requires_replay: false,
    schema_version: 1,
    algorithm: "ECHO-CM",
    payload: {
      requiresReplay: false,
      warnings: [], nodesAdded: [], nodesUpdated: [], nodesHidden: [],
      edgesAdded: [], edgesUpdated: [], edgesHidden: [], positionUpdates: [],
      changeScore: 0, reasonCodes: [], evidenceRefs: [],
    },
    created_at: new Date("2026-08-30T12:00:00.000Z"),
    ...override,
  };
}

function head(version: number, override: Record<string, unknown> = {}) {
  return {
    version: String(version), analysis_epoch: epoch,
    algorithm_version: "echo-v1", parameter_hash: hash, ...override,
  };
}

function fakePool(rows: Array<{ rows: unknown[] }>) {
  let index = 0;
  return {
    query: async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("AS room_exists")) {
        return {
          rows: [{ room_exists: true, deletion_active: false, policy_current: true, student_projection_allowed: true }],
          rowCount: 1,
        };
      }
      return rows[index++] ?? { rows: [] };
    },
  } as never;
}

describe("gate 3 projection resync", () => {
  it("resyncs a chain whose middle patch was corrupted, keeping no prefix", async () => {
    // 2 and 4 are intact and 3 does not build on 2: versions 1→2 are a
    // perfectly applicable prefix, and are still refused.
    const repository = new AnalyticsRepository(fakePool([
      { rows: [head(4)] },
      { rows: [patchRow(2, 1), patchRow(3, 9), patchRow(4, 3)] },
    ]));
    const result = await repository.patchesAfter(roomId, "echo.teacher_shadow", epoch, 1, snapshotUrl);
    expect(result).toEqual({ kind: "resync", snapshotUrl });
    expect(result).not.toHaveProperty("patches");
  });

  it("resyncs a chain truncated before the head rather than reporting it complete", async () => {
    const repository = new AnalyticsRepository(fakePool([
      { rows: [head(4)] },
      { rows: [patchRow(2, 1), patchRow(3, 2)] },
    ]));
    await expect(repository.patchesAfter(roomId, "echo.teacher_shadow", epoch, 1, snapshotUrl))
      .resolves.toEqual({ kind: "resync", snapshotUrl });
  });

  it("resyncs a chain whose first patch does not attach to the caller's version", async () => {
    const repository = new AnalyticsRepository(fakePool([
      { rows: [head(3)] },
      { rows: [patchRow(2, 0), patchRow(3, 2)] },
    ]));
    await expect(repository.patchesAfter(roomId, "echo.teacher_shadow", epoch, 1, snapshotUrl))
      .resolves.toEqual({ kind: "resync", snapshotUrl });
  });

  it("resyncs when a patch was produced by a different algorithm or parameters", async () => {
    for (const drift of [{ algorithm_version: "echo-v2" }, { parameter_hash: "b".repeat(64) }]) {
      const repository = new AnalyticsRepository(fakePool([
        { rows: [head(3)] },
        { rows: [patchRow(2, 1), patchRow(3, 2, drift)] },
      ]));
      await expect(repository.patchesAfter(roomId, "echo.teacher_shadow", epoch, 1, snapshotUrl))
        .resolves.toEqual({ kind: "resync", snapshotUrl });
    }
  });

  it("resyncs when the head has moved to a new analysis epoch", async () => {
    const repository = new AnalyticsRepository(fakePool([{ rows: [head(3, { analysis_epoch: otherEpoch })] }]));
    await expect(repository.patchesAfter(roomId, "echo.teacher_shadow", epoch, 1, snapshotUrl))
      .resolves.toEqual({ kind: "resync", snapshotUrl });
  });

  it("resyncs a caller claiming a version ahead of the head", async () => {
    const repository = new AnalyticsRepository(fakePool([{ rows: [head(3)] }]));
    await expect(repository.patchesAfter(roomId, "echo.teacher_shadow", epoch, 9, snapshotUrl))
      .resolves.toEqual({ kind: "resync", snapshotUrl });
  });

  it("resyncs a room that has no head at all", async () => {
    const repository = new AnalyticsRepository(fakePool([{ rows: [] }]));
    await expect(repository.patchesAfter(roomId, "echo.teacher_shadow", epoch, 0, snapshotUrl))
      .resolves.toEqual({ kind: "resync", snapshotUrl });
  });

  it("resyncs every TRACE patch request to the atomic bundle snapshot", async () => {
    for (const key of ["trace.teacher_bundle", "trace.student_bundle"] as const) {
      const url = routes.analytics.latest(roomId, key);
      // No head or patch query runs: a TRACE bundle has no patch form to
      // serve, so there is nothing to look up before answering.
      const repository = new AnalyticsRepository(fakePool([]));
      await expect(repository.patchesAfter(roomId, key, epoch, 1, url))
        .resolves.toEqual({ kind: "resync", snapshotUrl: url });
    }
  });

  it("returns a contiguous window when the chain is whole", async () => {
    const repository = new AnalyticsRepository(fakePool([
      { rows: [head(3)] },
      { rows: [patchRow(2, 1), patchRow(3, 2)] },
    ]));
    const result = await repository.patchesAfter(roomId, "echo.teacher_shadow", epoch, 1, snapshotUrl);
    expect(result.kind).toBe("patches");
    expect(result.kind === "patches" && result.patches.map((patch) => [patch.baseVersion, patch.version]))
      .toEqual([[1, 2], [2, 3]]);
  });
});
