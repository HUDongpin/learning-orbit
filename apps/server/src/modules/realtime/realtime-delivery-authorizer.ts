import type { Pool } from "pg";
import { authContract, type AuthSession } from "@learning-orbit/contracts";
import { tokenHash } from "../auth/crypto.js";

export type DeliveryAuthorization =
  | { ok: true; principal: AuthSession; actorId: string }
  | { ok: false; closeCode: 4401 | 4403 | 4410 };
export type TokenAuthorization =
  | { ok: true; sessionId: string; principal: AuthSession; actorId: string }
  | { ok: false; closeCode: 4401 | 4403 | 4410 };

/** Re-reads authorization for every inbound/outbound operation. */
export class RealtimeDeliveryAuthorizer {
  constructor(private readonly pool: Pool) {}

  async authenticateToken(rawToken: string | undefined, roomId: string): Promise<TokenAuthorization> {
    return this.#authenticateToken(rawToken, roomId, false);
  }

  async authenticateWebSocketToken(
    rawToken: string | undefined,
    roomId: string,
  ): Promise<TokenAuthorization> {
    return this.#authenticateToken(rawToken, roomId, true);
  }

  async #authenticateToken(
    rawToken: string | undefined,
    roomId: string,
    rejectClosedRoom: boolean,
  ): Promise<TokenAuthorization> {
    if (!rawToken || rawToken.length > 512) return { ok: false, closeCode: 4401 };
    const result = await this.pool.query<{
      session_id: string; principal_kind: "teacher" | "student"; teacher_id: string | null;
      room_id: string | null; room_member_id: string | null; actor_id: string | null;
      pseudonym: string | null; nova_actor_id: string | null; room_status: string | null;
      deletion_active: boolean;
    }>(
      `SELECT s.session_id, s.principal_kind, s.teacher_id, m.room_id, s.room_member_id,
              m.actor_id, m.pseudonym, r.nova_actor_id, r.status AS room_status,
              EXISTS (
                SELECT 1 FROM deletion_job d
                WHERE d.room_id=r.room_id
                  AND d.status IN ('queued','running','retryable','dead')
              ) AS deletion_active
       FROM auth_session s
       LEFT JOIN room_member m ON m.room_member_id=s.room_member_id
       LEFT JOIN classroom_room r ON r.room_id=m.room_id OR (s.principal_kind='teacher' AND r.teacher_id=s.teacher_id)
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
         AND ((s.principal_kind='teacher' AND r.room_id=$2 AND r.teacher_id=s.teacher_id)
              OR (s.principal_kind='student' AND r.room_id=$2))
       LIMIT 1`,
      [tokenHash(rawToken), roomId],
    );
    const row = result.rows[0];
    if (!row) return { ok: false, closeCode: 4401 };
    if (row.deletion_active !== false) return { ok: false, closeCode: 4410 };
    // Ordinary authenticated HTTP reads remain available after room.closed.
    // Only a fresh WebSocket Upgrade is rejected; an existing connection is
    // reauthorized below and may receive later deletion/authority changes.
    if (rejectClosedRoom && row.room_status === "closed") {
      return { ok: false, closeCode: 4410 };
    }
    if (row.principal_kind === "teacher" && row.teacher_id) {
      return { ok: true, sessionId: row.session_id, principal: authContract.parseSession({ role: "teacher", teacherId: row.teacher_id, actorId: row.teacher_id }), actorId: row.teacher_id };
    }
    if (row.room_id !== roomId || !row.room_member_id || !row.actor_id || !row.pseudonym || !row.nova_actor_id) return { ok: false, closeCode: 4403 };
    return {
      ok: true, sessionId: row.session_id, actorId: row.actor_id,
      principal: authContract.parseSession({ role: "student", roomId, roomMemberId: row.room_member_id, actorId: row.actor_id, pseudonym: row.pseudonym, nova: { actorId: row.nova_actor_id, actorKind: "agent", actorRole: "socratic_facilitator", displayName: "Nova Agent" } }),
    };
  }

  async reauthorize(sessionId: string, roomId: string): Promise<DeliveryAuthorization> {
    const result = await this.pool.query<{ token_hash: Buffer }>("SELECT token_hash FROM auth_session WHERE session_id=$1 AND revoked_at IS NULL AND expires_at>now()", [sessionId]);
    if (!result.rows[0]) return { ok: false, closeCode: 4401 };
    // Session IDs are durable but the opaque token is not available here. Re-read
    // the identity by session joins, preserving revocation/expiry semantics.
    const identity = await this.pool.query<{
      principal_kind: "teacher" | "student"; teacher_id: string | null; room_id: string | null;
      room_member_id: string | null; actor_id: string | null; pseudonym: string | null; nova_actor_id: string | null; room_status: string | null;
      deletion_active: boolean;
    }>(
      `SELECT s.principal_kind,s.teacher_id,m.room_id,s.room_member_id,m.actor_id,m.pseudonym,r.nova_actor_id,r.status AS room_status,
              EXISTS (
                SELECT 1 FROM deletion_job d
                WHERE d.room_id=r.room_id
                  AND d.status IN ('queued','running','retryable','dead')
              ) AS deletion_active
       FROM auth_session s LEFT JOIN room_member m ON m.room_member_id=s.room_member_id
       LEFT JOIN classroom_room r ON r.room_id=m.room_id OR (s.principal_kind='teacher' AND r.teacher_id=s.teacher_id)
       WHERE s.session_id=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
         AND ((s.principal_kind='teacher' AND r.room_id=$2 AND r.teacher_id=s.teacher_id)
              OR (s.principal_kind='student' AND r.room_id=$2))
       LIMIT 1`, [sessionId, roomId],
    );
    const row = identity.rows[0];
    if (!row) return { ok: false, closeCode: 4403 };
    if (row.deletion_active !== false) return { ok: false, closeCode: 4410 };
    if (row.principal_kind === "teacher" && row.teacher_id) return { ok: true, actorId: row.teacher_id, principal: authContract.parseSession({ role: "teacher", teacherId: row.teacher_id, actorId: row.teacher_id }) };
    if (row.room_id !== roomId || !row.room_member_id || !row.actor_id || !row.pseudonym || !row.nova_actor_id) return { ok: false, closeCode: 4403 };
    return { ok: true, actorId: row.actor_id, principal: authContract.parseSession({ role: "student", roomId, roomMemberId: row.room_member_id, actorId: row.actor_id, pseudonym: row.pseudonym, nova: { actorId: row.nova_actor_id, actorKind: "agent", actorRole: "socratic_facilitator", displayName: "Nova Agent" } }) };
  }
}
