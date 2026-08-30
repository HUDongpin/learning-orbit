import { describe, expect, it } from "vitest";

import type { AuthSession } from "@learning-orbit/contracts";
import { AnalyticsPolicy } from "../../src/modules/analytics/analytics-policy.js";

const roomId = "00000000-0000-4000-8000-000000000010";
const teacher: Extract<AuthSession, { role: "teacher" }> = {
  role: "teacher",
  teacherId: "00000000-0000-4000-8000-000000000001",
  actorId: "00000000-0000-4000-8000-000000000001",
};
const sessionId = "00000000-0000-4000-8000-000000000777";

describe("AnalyticsPolicy role and lifecycle boundary", () => {
  it("allows only the role-owned projection pair", () => {
    const policy = new AnalyticsPolicy({} as any);
    const teacherGrant = { roomId, role: "teacher" as const, studentProjectionAllowlist: new Set<string>() };
    expect(() => policy.assertProjection(teacherGrant, "echo.teacher_shadow")).not.toThrow();
    expect(() => policy.assertProjection(teacherGrant, "trace.teacher_bundle")).not.toThrow();
    expect(() => policy.assertProjection(teacherGrant, "echo.student_approved")).toThrow("PROJECTION_NOT_FOUND");
    expect(() => policy.assertProjection(teacherGrant, "trace.student_bundle")).toThrow("PROJECTION_NOT_FOUND");

    const studentGrant = { roomId, role: "student" as const, studentProjectionAllowlist: new Set(["echo.student_approved"]) };
    expect(() => policy.assertProjection(studentGrant, "echo.student_approved")).not.toThrow();
    expect(() => policy.assertProjection(studentGrant, "trace.student_bundle")).toThrow("STUDENT_ANALYTICS_NOT_PROMOTED");
    expect(() => policy.assertProjection(studentGrant, "echo.teacher_shadow")).toThrow("PROJECTION_FORBIDDEN");
  });

  it("keeps a normally closed room readable when no deletion job is active", async () => {
    const pool = { query: async () => ({ rows: [{ room_id: roomId, status: "closed", policy_current: true, deletion_active: false }] }) } as any;
    await expect(new AnalyticsPolicy(pool).requireRoomAccess(teacher, roomId, "latest", sessionId))
      .resolves.toMatchObject({ roomId, role: "teacher" });
  });

  it("freezes analytics only for a real unfinished deletion job", async () => {
    const pool = { query: async () => ({ rows: [{ room_id: roomId, status: "closed", policy_current: true, deletion_active: true }] }) } as any;
    await expect(new AnalyticsPolicy(pool).requireRoomAccess(teacher, roomId, "latest", sessionId))
      .rejects.toMatchObject({ statusCode: 410, code: "ROOM_DELETION_IN_PROGRESS" });
  });
});
