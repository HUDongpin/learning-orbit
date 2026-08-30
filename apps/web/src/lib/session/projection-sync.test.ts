import { describe, expect, it } from "vitest";

import type { AuthSession, ProjectionFrame } from "@learning-orbit/contracts";
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
});
