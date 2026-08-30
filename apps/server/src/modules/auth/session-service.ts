import type { Pool } from "pg";

import { authContract, type AuthSession } from "@learning-orbit/contracts";
import { tokenHash } from "./crypto.js";

export class SessionService {
  constructor(private readonly pool: Pool) {}

  async get(rawToken: string | undefined): Promise<AuthSession | null> {
    if (!rawToken || rawToken.length > 512) return null;
    const result = await this.pool.query<{
      principal_kind: "teacher" | "student"; teacher_id: string | null; room_id: string | null;
      room_member_id: string | null; actor_id: string | null; pseudonym: string | null; nova_actor_id: string | null;
    }>(
      `SELECT s.principal_kind, s.teacher_id, m.room_id, s.room_member_id, m.actor_id, m.pseudonym, r.nova_actor_id
       FROM auth_session s
       LEFT JOIN room_member m ON m.room_member_id = s.room_member_id
       LEFT JOIN classroom_room r ON r.room_id = m.room_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`, [tokenHash(rawToken)],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.principal_kind === "teacher" && row.teacher_id) {
      return authContract.parseSession({ role: "teacher", teacherId: row.teacher_id, actorId: row.teacher_id });
    }
    if (!row.room_id || !row.room_member_id || !row.actor_id || !row.pseudonym || !row.nova_actor_id) return null;
    return authContract.parseSession({
      role: "student", roomId: row.room_id, roomMemberId: row.room_member_id, actorId: row.actor_id,
      pseudonym: row.pseudonym,
      nova: { actorId: row.nova_actor_id, actorKind: "agent", actorRole: "socratic_facilitator", displayName: "Nova Agent" },
    });
  }

  async revoke(rawToken: string | undefined): Promise<void> {
    if (!rawToken || rawToken.length > 512) return;
    await this.pool.query(
      "UPDATE auth_session SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [tokenHash(rawToken)],
    );
  }
}
