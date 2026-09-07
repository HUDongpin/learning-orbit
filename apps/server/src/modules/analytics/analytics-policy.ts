import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import type { AuthSession } from "@learning-orbit/contracts";

import type { SecurityAuditLog } from "../security/security-audit.js";

export const STUDENT_PROJECTIONS = new Set([
  "echo.student_approved",
  "trace.student_bundle",
]);
export const TEACHER_PROJECTIONS = new Set([
  "echo.teacher_shadow",
  "trace.teacher_bundle",
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
  constructor(
    private readonly pool: Pool,
    private readonly audit?: Pick<SecurityAuditLog, "record">,
  ) {}

  /**
   * Every analytics decision is recorded, allowed or refused alike. A trail
   * that holds only refusals cannot show who saw what, and one that holds only
   * grants cannot show what was attempted.
   */
  async requireRoomAccess(
    principal: AuthSession | null,
    roomId: string,
    capability: AnalyticsCapability,
    sessionId?: string,
  ): Promise<AnalyticsGrant> {
    try {
      const grant = await this.#evaluate(principal, roomId, capability, sessionId);
      await this.#audit(principal, roomId, "allowed", grant.role.toUpperCase());
      return grant;
    } catch (error) {
      const rejected = error instanceof AnalyticsPolicyError;
      await this.#audit(
        principal,
        roomId,
        rejected ? "rejected" : "failed",
        rejected ? error.code : "ANALYTICS_ACCESS_FAILED",
      );
      throw error;
    }
  }

  async #audit(
    principal: AuthSession | null,
    roomId: string,
    outcome: "allowed" | "rejected" | "failed",
    reasonCode: string,
  ): Promise<void> {
    await this.audit?.record({
      principalKind: principal?.role ?? "anonymous",
      action: "analytics.read",
      outcome,
      reasonCode,
      correlationId: randomUUID(),
      roomId,
    });
  }

  async #evaluate(
    principal: AuthSession | null,
    roomId: string,
    _capability: AnalyticsCapability,
    sessionId?: string,
  ): Promise<AnalyticsGrant> {
    if (!principal) throw new AnalyticsPolicyError(401, "AUTH_REQUIRED");
    if (!sessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
      throw new AnalyticsPolicyError(401, "AUTH_REQUIRED");
    }
    if (principal.role === "teacher") {
      const result = await this.pool.query<{ room_id: string; status: string; policy_current: boolean; deletion_active: boolean }>(
        `SELECT r.room_id,r.status,
                (p.policy_id IS NOT NULL AND p.approved_at <= transaction_timestamp()
                 AND p.expires_at > transaction_timestamp()) AS policy_current,
                EXISTS (
                  SELECT 1 FROM deletion_job d
                  WHERE d.room_id=r.room_id
                    AND d.status IN ('queued','running','retryable','dead')
                ) AS deletion_active
         FROM classroom_room r
         LEFT JOIN pilot_retention_policy p ON p.policy_id=r.retention_policy_id
         WHERE r.room_id=$1 AND r.teacher_id=$2
           AND EXISTS (
             SELECT 1 FROM auth_session s
             WHERE s.session_id=$3::uuid AND s.teacher_id=r.teacher_id
               AND s.principal_kind='teacher' AND s.revoked_at IS NULL
               AND s.expires_at > transaction_timestamp())`,
         [roomId, principal.teacherId, sessionId],
      );
      const row = result.rows[0];
      if (!row) throw new AnalyticsPolicyError(404, "ROOM_NOT_FOUND");
      if (row.deletion_active === true) throw new AnalyticsPolicyError(410, "ROOM_DELETION_IN_PROGRESS");
      if (row.policy_current !== true) {
        throw new AnalyticsPolicyError(410, "RETENTION_POLICY_EXPIRED");
      }
      return { roomId, role: "teacher", studentProjectionAllowlist: new Set() };
    }
    const result = await this.pool.query<{ room_id: string; status: string; policy_current: boolean; deletion_active: boolean }>(
      `SELECT r.room_id,r.status,
              (p.policy_id IS NOT NULL AND p.approved_at <= transaction_timestamp()
               AND p.expires_at > transaction_timestamp()) AS policy_current,
              EXISTS (
                SELECT 1 FROM deletion_job d
                WHERE d.room_id=r.room_id
                  AND d.status IN ('queued','running','retryable','dead')
              ) AS deletion_active
       FROM room_member m JOIN classroom_room r ON r.room_id=m.room_id
       LEFT JOIN pilot_retention_policy p ON p.policy_id=r.retention_policy_id
       WHERE r.room_id=$1 AND m.room_member_id=$2 AND m.actor_id=$3
         AND EXISTS (
           SELECT 1 FROM auth_session s
           WHERE s.session_id=$4::uuid AND s.room_member_id=m.room_member_id
             AND s.principal_kind='student' AND s.revoked_at IS NULL
             AND s.expires_at > transaction_timestamp())`,
      [roomId, principal.roomMemberId, principal.actorId, sessionId],
    );
    const row = result.rows[0];
    if (!row) throw new AnalyticsPolicyError(404, "ROOM_NOT_FOUND");
    if (row.deletion_active === true) throw new AnalyticsPolicyError(410, "ROOM_DELETION_IN_PROGRESS");
    if (row.policy_current !== true) {
      throw new AnalyticsPolicyError(410, "RETENTION_POLICY_EXPIRED");
    }
    const promotion = await this.pool.query<{ feature_allowlist: string[]; promotion_record_sha256: string; policy_revision: string }>(
      `SELECT feature_allowlist,promotion_record_sha256,policy_revision
       FROM student_analytics_promotion
       WHERE room_id=$1
         AND revoked_at IS NULL
         AND starts_at <= transaction_timestamp()
         AND expires_at > transaction_timestamp()
       ORDER BY policy_revision DESC
       LIMIT 1`,
      [roomId],
    );
    const promotionRow = promotion.rows[0];
    if (promotionRow && (!/^[a-f0-9]{64}$/.test(promotionRow.promotion_record_sha256)
      || !/^[1-9][0-9]*$/.test(String(promotionRow.policy_revision))
      || !Array.isArray(promotionRow.feature_allowlist)
      || promotionRow.feature_allowlist.some((key) => typeof key !== "string" || !STUDENT_PROJECTIONS.has(key))
      || new Set(promotionRow.feature_allowlist).size !== promotionRow.feature_allowlist.length)) {
      throw new AnalyticsPolicyError(403, "STUDENT_ANALYTICS_NOT_PROMOTED");
    }
    const allowlist = new Set(promotionRow?.feature_allowlist ?? []);
    return { roomId, role: "student", studentProjectionAllowlist: allowlist };
  }

  assertProjection(grant: AnalyticsGrant, projectionKey: string): void {
    if (grant.role === "teacher") {
      if (!TEACHER_PROJECTIONS.has(projectionKey)) {
        throw new AnalyticsPolicyError(404, "PROJECTION_NOT_FOUND");
      }
      return;
    }
    if (!TEACHER_PROJECTIONS.has(projectionKey) && !STUDENT_PROJECTIONS.has(projectionKey)) {
      throw new AnalyticsPolicyError(404, "PROJECTION_NOT_FOUND");
    }
    if (!STUDENT_PROJECTIONS.has(projectionKey)) {
      throw new AnalyticsPolicyError(403, "PROJECTION_FORBIDDEN");
    }
    if (!grant.studentProjectionAllowlist.has(projectionKey)) {
      throw new AnalyticsPolicyError(403, "STUDENT_ANALYTICS_NOT_PROMOTED");
    }
  }
}
