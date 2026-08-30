import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { Clock } from "../../clock.js";
import { inTransaction } from "../../db/transactions.js";
import { opaqueToken, tokenHash } from "./crypto.js";

export type SendMagicLink = (email: string, url: string) => Promise<void>;

export interface MagicLinkResult { readonly token: string; }

export class MagicLinkService {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
    private readonly publicBaseOrigin: string,
    private readonly sender: SendMagicLink,
  ) {}

  async request(email: string): Promise<void> {
    const token = opaqueToken();
    const expiresAt = new Date(this.clock.now().getTime() + 15 * 60 * 1000);
    const row = await this.pool.query<{ teacher_id: string }>(
      `INSERT INTO magic_link(magic_link_id, teacher_id, token_hash, expires_at, created_at)
       SELECT $1, teacher_id, $2, $3, $4 FROM teacher_account WHERE email = $5
       RETURNING teacher_id`,
      [randomUUID(), tokenHash(token), expiresAt, this.clock.now(), email],
    );
    if (!row.rowCount) return;
    const url = new URL("/v1/auth/teacher/magic-link/consume", this.publicBaseOrigin);
    url.searchParams.set("token", token);
    try { await this.sender(email, url.toString()); } catch { /* deliberately non-enumerating */ }
  }

  async consume(rawToken: string): Promise<MagicLinkResult | null> {
    if (!rawToken || rawToken.length > 512) return null;
    return inTransaction(this.pool, async (tx: PoolClient) => {
      const consumed = await tx.query<{ teacher_id: string }>(
        `UPDATE magic_link SET consumed_at = $2
         WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2
         RETURNING teacher_id`, [tokenHash(rawToken), this.clock.now()],
      );
      const teacherId = consumed.rows[0]?.teacher_id;
      if (!teacherId) return null;
      const sessionToken = opaqueToken();
      await tx.query(
        `INSERT INTO auth_session(session_id, token_hash, principal_kind, teacher_id, expires_at, created_at)
         VALUES ($1, $2, 'teacher', $3, $4, $5)`,
        [randomUUID(), tokenHash(sessionToken), teacherId,
          new Date(this.clock.now().getTime() + 8 * 60 * 60 * 1000), this.clock.now()],
      );
      return { token: sessionToken };
    });
  }
}
