import type { Pool } from "pg";
import type { Clock } from "../../clock.js";

export type ProviderHealth = "healthy" | "degraded" | "unavailable";
export type ProviderHealthSample = Readonly<{
  providerId: string; manifestSha256: string; health: ProviderHealth;
  checkedAt: Date; reasonCode: string | null; signatureKeyId: string; signature: Buffer;
}>;

export class ProviderHealthRepository {
  constructor(private readonly pool: Pool, private readonly clock: Clock) {}

  async upsert(sample: ProviderHealthSample): Promise<"accepted" | "ignored_stale"> {
    const result = await this.pool.query(
      `INSERT INTO agent_provider_health(provider_id, manifest_sha256, health, checked_at, reason_code, signature_key_id, signature, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (provider_id) DO UPDATE SET
         manifest_sha256 = EXCLUDED.manifest_sha256, health = EXCLUDED.health,
         checked_at = EXCLUDED.checked_at, reason_code = EXCLUDED.reason_code,
         signature_key_id = EXCLUDED.signature_key_id, signature = EXCLUDED.signature,
         updated_at = EXCLUDED.updated_at
       WHERE agent_provider_health.manifest_sha256 = EXCLUDED.manifest_sha256
         AND agent_provider_health.checked_at < EXCLUDED.checked_at
       RETURNING provider_id`,
      [sample.providerId, sample.manifestSha256, sample.health, sample.checkedAt,
        sample.reasonCode, sample.signatureKeyId, sample.signature, this.clock.now()],
    );
    return result.rowCount === 1 ? "accepted" : "ignored_stale";
  }

  async current(providerId: string, manifestSha256: string): Promise<ProviderHealth> {
    const result = await this.pool.query<{ health: ProviderHealth; checked_at: Date }>(
      `SELECT health, checked_at FROM agent_provider_health WHERE provider_id = $1 AND manifest_sha256 = $2`,
      [providerId, manifestSha256],
    );
    const row = result.rows[0];
    if (!row || !(row.checked_at instanceof Date) || this.clock.now().getTime() - row.checked_at.getTime() > 30_000) return "unavailable";
    if (row.checked_at.getTime() - this.clock.now().getTime() > 5_000) return "unavailable";
    return row.health;
  }
}
