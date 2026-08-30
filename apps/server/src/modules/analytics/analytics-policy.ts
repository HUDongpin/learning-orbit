import type { Pool } from "pg";
import type { AuthSession } from "@learning-orbit/contracts";

export const STUDENT_PROJECTIONS = new Set([
  "echo.student_approved",
  "trace.student_bundle",
]);
export const TEACHER_PROJECTIONS = new Set([
  "echo.teacher_shadow",
  "trace.teacher_bundle",
  ...STUDENT_PROJECTIONS,
]);
export type AnalyticsCapability = "latest" | "patches" | "timeline" | "projection_frame";

export class AnalyticsPolicyError extends Error {
  constructor(readonly statusCode: 401 | 403 | 404 | 410, readonly code: string) {
    super(code);
  }
}

export interface AnalyticsGrant {
  readonly roomId: string;
  readonly role: "teacher" | "student";
  readonly studentProjectionAllowlist: ReadonlySet<string>;
}

/**
 * Analytics access is evaluated against the current session/room relation on
 * every request.  Student promotion is intentionally fail-closed until the
 * governance migration installs a signed per-projection grant.
 */
export class AnalyticsPolicy {
  constructor(private readonly pool: Pool) {}

  async requireRoomAccess(
    principal: AuthSession | null,
    roomId: string,
    _capability: AnalyticsCapability,
  ): Promise<AnalyticsGrant> {
    if (!principal) throw new AnalyticsPolicyError(401, "AUTH_REQUIRED");
    if (principal.role === "teacher") {
      const result = await this.pool.query<{ room_id: string; status: string }>(
        "SELECT room_id,status FROM classroom_room WHERE room_id=$1 AND teacher_id=$2",
        [roomId, principal.teacherId],
      );
      const row = result.rows[0];
      if (!row) throw new AnalyticsPolicyError(404, "ROOM_NOT_FOUND");
      if (row.status === "closed") throw new AnalyticsPolicyError(410, "ROOM_DELETION_IN_PROGRESS");
      return { roomId, role: "teacher", studentProjectionAllowlist: new Set() };
    }
    const result = await this.pool.query<{ room_id: string; status: string }>(
      `SELECT r.room_id,r.status
       FROM room_member m JOIN classroom_room r ON r.room_id=m.room_id
       WHERE r.room_id=$1 AND m.room_member_id=$2 AND m.actor_id=$3`,
      [roomId, principal.roomMemberId, principal.actorId],
    );
    const row = result.rows[0];
    if (!row) throw new AnalyticsPolicyError(404, "ROOM_NOT_FOUND");
    if (row.status === "closed") throw new AnalyticsPolicyError(410, "ROOM_DELETION_IN_PROGRESS");
    return { roomId, role: "student", studentProjectionAllowlist: new Set() };
  }

  assertProjection(grant: AnalyticsGrant, projectionKey: string): void {
    if (!TEACHER_PROJECTIONS.has(projectionKey)) {
      throw new AnalyticsPolicyError(404, "PROJECTION_NOT_FOUND");
    }
    if (grant.role === "student" && !STUDENT_PROJECTIONS.has(projectionKey)) {
      throw new AnalyticsPolicyError(403, "PROJECTION_FORBIDDEN");
    }
    if (grant.role === "student" && !grant.studentProjectionAllowlist.has(projectionKey)) {
      throw new AnalyticsPolicyError(403, "STUDENT_ANALYTICS_NOT_PROMOTED");
    }
  }
}
