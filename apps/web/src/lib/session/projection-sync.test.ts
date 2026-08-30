import { describe, expect, it } from "vitest";

import type {
  AuthSession,
  ProjectionFrame,
  SnaProjectionBundle,
  StudentConceptMapPatch,
  StudentConceptMapSnapshot,
} from "@learning-orbit/contracts";
import { ProjectionSync } from "./projection-sync.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const EPOCH_ONE = "00000000-0000-4000-8000-000000000601";
const EPOCH_TWO = "00000000-0000-4000-8000-000000000602";
const teacher: Extract<AuthSession, { role: "teacher" }> = {
  role: "teacher",
  teacherId: "00000000-0000-4000-8000-000000000001",
  actorId: "00000000-0000-4000-8000-000000000001",
};
const student: Extract<AuthSession, { role: "student" }> = {
  role: "student",
  roomId: ROOM_ID,
  roomMemberId: "00000000-0000-4000-8000-000000000011",
  actorId: "00000000-0000-4000-8000-000000000012",
  pseudonym: "探索者 A",
  nova: { actorId: "00000000-0000-4000-8000-000000000013", actorKind: "agent", actorRole: "socratic_facilitator", displayName: "Nova Agent" },
};

function frame(
  projectionKey: ProjectionFrame["projectionKey"],
  projectionVersion: number,
  analysisEpoch = EPOCH_ONE,
  completeThroughRoomSeq = projectionVersion,
): ProjectionFrame {
  return {
    type: "projection",
    roomId: ROOM_ID,
    projectionKey,
    analysisEpoch,
    projectionVersion,
    completeThroughRoomSeq,
    snapshotUrl: `/v1/rooms/${ROOM_ID}/analytics/${projectionKey}/latest`,
  };
}

function echoSnapshot(version = 1, completeThroughRoomSeq = 4): StudentConceptMapSnapshot {
  return {
    schemaVersion: 1,
    projectionKey: "echo.student_approved",
    roomId: ROOM_ID,
    analysisEpoch: EPOCH_ONE,
    algorithmVersion: "echo-v1",
    parameterHash: "b".repeat(64),
    projectionVersion: version,
    baseVersion: version - 1,
    completeThroughRoomSeq,
    watermarkEventTime: "2026-08-30T09:00:00.000Z",
    requiresReplay: false,
    evidenceStatus: "active",
    reviewStatus: "unreviewed",
    displayStatus: "student_approved",
    warnings: [],
    payload: { nodes: [], edges: [] },
  };
}

function echoPatch(): StudentConceptMapPatch {
  return {
    analysisEpoch: EPOCH_ONE,
    algorithmVersion: "echo-v1",
    parameterHash: "b".repeat(64),
    projectionVersion: 2,
    baseVersion: 1,
    completeThroughRoomSeq: 5,
    requiresReplay: false,
    warnings: [],
    nodesAdded: [], nodesUpdated: [], nodesHidden: [],
    edgesAdded: [], edgesUpdated: [], edgesHidden: [], positionUpdates: [],
    changeScore: 0, reasonCodes: [],
  };
}

const traceView = {
  nodes: [], edges: [],
  metrics: { participationBalance: 0, reciprocity: 0, agentShare: 0, semanticCoverage: 0 },
  warnings: ["small_group_interpretation_warning" as const],
};
function traceSnapshot(): Extract<SnaProjectionBundle, { projectionKey: "trace.student_bundle" }> {
  return {
    schemaVersion: 1, projectionKey: "trace.student_bundle", roomId: ROOM_ID,
    analysisEpoch: EPOCH_ONE, algorithmVersion: "trace-v1", parameterHash: "c".repeat(64),
    projectionVersion: 1, baseVersion: 0, completeThroughRoomSeq: 4,
    watermarkEventTime: "2026-08-30T09:00:00.000Z", requiresReplay: false,
    evidenceStatus: "active", reviewStatus: "approved", displayStatus: "student_aggregate",
    warnings: ["small_group_interpretation_warning"],
    payload: {
      windows: {
        recent_10m: { windowStartEventTime: "2026-08-30T08:50:00.000Z", windowEndEventTime: "2026-08-30T09:00:00.000Z", views: { observed: traceView, human_only: traceView, lineage_adjusted: traceView } },
        session_45m: { windowStartEventTime: "2026-08-30T08:15:00.000Z", windowEndEventTime: "2026-08-30T09:00:00.000Z", views: { observed: traceView, human_only: traceView, lineage_adjusted: traceView } },
      },
      interpretation: "此圖呈現系統觀測到的近期互動事件，不等同友情、地位、能力、貢獻價值、學習成績、心理關係或 Agent 因果效果。",
    },
  };
}

describe("ProjectionSync pointer ledger", () => {
  it("accepts only contiguous versions and keeps a gap non-mutating", () => {
    const sync = new ProjectionSync(ROOM_ID, student);
    expect(sync.accept(frame("echo.student_approved", 1))).toBe("accepted");
    expect(sync.accept(frame("echo.student_approved", 1))).toBe("duplicate");
    expect(sync.accept(frame("echo.student_approved", 3))).toBe("gap");
    expect(sync.current("echo.student_approved")?.projectionVersion).toBe(1);
    expect(sync.accept(frame("echo.student_approved", 2))).toBe("accepted");
  });

  it("treats a new analysis epoch as a snapshot boundary", () => {
    const sync = new ProjectionSync(ROOM_ID, teacher);
    expect(sync.accept(frame("trace.teacher_bundle", 4))).toBe("accepted");
    expect(sync.accept(frame("trace.teacher_bundle", 1, EPOCH_TWO, 8))).toBe("epoch_changed");
    expect(sync.current("trace.teacher_bundle")).toMatchObject({ analysisEpoch: EPOCH_TWO, projectionVersion: 1 });
  });

  it("rejects role-incompatible keys, cross-room pointers, and non-canonical snapshot URLs", () => {
    const sync = new ProjectionSync(ROOM_ID, student);
    expect(() => sync.accept(frame("echo.teacher_shadow", 1))).toThrow("PROJECTION_ROLE_FORBIDDEN");
    expect(() => sync.accept({ ...frame("echo.student_approved", 1), roomId: "00000000-0000-4000-8000-000000000099" }))
      .toThrow("PROJECTION_ROOM_MISMATCH");
    expect(() => sync.accept({ ...frame("echo.student_approved", 1), snapshotUrl: "https://evil.example/snapshot" }))
      .toThrow("PROJECTION_SNAPSHOT_URL_INVALID");
    expect(sync.references()).toEqual([]);
    sync.clearAuthority();
    expect(() => sync.accept(frame("echo.student_approved", 1))).toThrow("PROJECTION_AUTHORITY_CLEARED");
  });

  it("stores only role-safe generated snapshots and clears one policy-revoked slot", () => {
    const sync = new ProjectionSync(ROOM_ID, student);
    expect(sync.allowedKeys()).toEqual(["echo.student_approved", "trace.student_bundle"]);
    expect(sync.slot("echo.student_approved")).toEqual({ availability: "loading" });
    sync.replaceSnapshot(echoSnapshot());
    sync.replaceSnapshot(traceSnapshot());
    expect(sync.slot("echo.student_approved")).toMatchObject({ availability: "ready", snapshot: { projectionVersion: 1 } });
    expect(sync.slot("trace.student_bundle")).toMatchObject({ availability: "ready", snapshot: { projectionVersion: 1 } });

    sync.markPolicyUnavailable("echo.student_approved");
    expect(sync.slot("echo.student_approved")).toEqual({ availability: "not_available_by_policy" });
    expect(sync.current("echo.student_approved")).toBeUndefined();
    expect(sync.slot("trace.student_bundle")).toMatchObject({ availability: "ready", snapshot: { projectionKey: "trace.student_bundle" } });
  });

  it("applies an exact ECHO patch target atomically and preserves last-good on ordinary failure", () => {
    const sync = new ProjectionSync(ROOM_ID, student);
    sync.replaceSnapshot(echoSnapshot());
    const target = frame("echo.student_approved", 2, EPOCH_ONE, 5);
    sync.applyEchoPatches("echo.student_approved", [echoPatch()], target);
    expect(sync.slot("echo.student_approved")).toMatchObject({
      availability: "ready",
      snapshot: { projectionVersion: 2, completeThroughRoomSeq: 5 },
    });
    expect(sync.current("echo.student_approved")).toEqual(target);

    sync.markFailed("echo.student_approved", "ANALYTICS_CORRUPT");
    expect(sync.slot("echo.student_approved")).toMatchObject({
      availability: "failed",
      errorCode: "ANALYTICS_CORRUPT",
      snapshot: { projectionVersion: 2 },
    });
    expect(() => sync.applyEchoPatches("echo.student_approved", [{ ...echoPatch(), baseVersion: 0 }], target))
      .toThrow(/CONCEPT_PATCH_/u);
    expect(sync.slot("echo.student_approved").snapshot).toMatchObject({ projectionVersion: 2 });
  });
});
