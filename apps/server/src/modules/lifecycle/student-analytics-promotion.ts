import type { Pool, PoolClient } from "pg";

import { inTransaction } from "../../db/transactions.js";
import { canonicalJson } from "../security/canonical-json.js";

export const STUDENT_PROJECTION_KEYS = Object.freeze([
  "echo.student_approved",
  "trace.student_bundle",
] as const);

export type StudentProjectionKey = (typeof STUDENT_PROJECTION_KEYS)[number];

export const POLICY_CHANGE_CHANNEL = "student_analytics_policy_changed";
/** PostgreSQL refuses a NOTIFY payload of 8000 bytes or more. */
const MAX_NOTIFY_BYTES = 7_500;

export class StudentPromotionError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface PromotionGrant {
  readonly roomId: string;
  /** Digest of the signed student_visible_promotion record that authorised this. */
  readonly promotionRecordSha256: string;
  readonly featureAllowlist: readonly StudentProjectionKey[];
  readonly startsAt: Date;
  readonly expiresAt: Date;
}

export interface PolicyChangeNotice {
  readonly roomId: string;
  readonly changedKeys: readonly StudentProjectionKey[];
  readonly revision: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertGrant(grant: PromotionGrant): void {
  if (!UUID.test(grant.roomId)
    || !/^[a-f0-9]{64}$/.test(grant.promotionRecordSha256)
    || !Array.isArray(grant.featureAllowlist)
    || grant.featureAllowlist.some((key) => !STUDENT_PROJECTION_KEYS.includes(key))
    || new Set(grant.featureAllowlist).size !== grant.featureAllowlist.length
    || !(grant.startsAt instanceof Date) || !Number.isFinite(grant.startsAt.getTime())
    || !(grant.expiresAt instanceof Date) || !Number.isFinite(grant.expiresAt.getTime())
    || grant.expiresAt.getTime() <= grant.startsAt.getTime()) {
    throw new StudentPromotionError("STUDENT_PROMOTION_RECORD_INVALID");
  }
}

/**
 * Validate a notification before anything acts on it.
 *
 * The payload crosses a PostgreSQL channel any database role could in
 * principle write to, so it is re-validated on arrival and used only to decide
 * *which room to re-read* - never as the authority for what a student may see.
 * That authority is always the durable row.
 */
export function parsePolicyChangeNotice(payload: string): PolicyChangeNotice {
  if (typeof payload !== "string" || payload.length > MAX_NOTIFY_BYTES) {
    throw new StudentPromotionError("STUDENT_POLICY_NOTICE_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new StudentPromotionError("STUDENT_POLICY_NOTICE_INVALID");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StudentPromotionError("STUDENT_POLICY_NOTICE_INVALID");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "changedKeys" || keys[1] !== "revision" || keys[2] !== "roomId"
    || typeof record.roomId !== "string" || !UUID.test(record.roomId)
    || !Array.isArray(record.changedKeys)
    || record.changedKeys.some((key) => typeof key !== "string"
      || !STUDENT_PROJECTION_KEYS.includes(key as StudentProjectionKey))
    || new Set(record.changedKeys).size !== record.changedKeys.length
    || !Number.isSafeInteger(record.revision) || (record.revision as number) < 1) {
    throw new StudentPromotionError("STUDENT_POLICY_NOTICE_INVALID");
  }
  return Object.freeze({
    roomId: record.roomId,
    changedKeys: Object.freeze([...record.changedKeys] as StudentProjectionKey[]),
    revision: record.revision as number,
  });
}

/**
 * The only writer of student analytics visibility.
 *
 * Default-deny: a room with no row shows students nothing, and every change is
 * a whole-room decision carrying the digest of the signed record that
 * authorised it. Revocation is a tombstone with a higher revision rather than
 * a delete, so a late notification can never be mistaken for a fresh grant.
 */
export class StudentAnalyticsPromotionService {
  constructor(private readonly pool: Pool) {}

  async grant(grant: PromotionGrant): Promise<PolicyChangeNotice> {
    assertGrant(grant);
    return inTransaction(this.pool, async (tx) => {
      const before = await this.#currentKeys(tx, grant.roomId);
      const result = await tx.query<{ policy_revision: string }>(
        `INSERT INTO student_analytics_promotion(
           room_id, promotion_record_sha256, policy_revision, feature_allowlist,
           starts_at, expires_at, revoked_at)
         VALUES($1,$2,1,$3::text[],$4,$5,NULL)
         ON CONFLICT (room_id) DO UPDATE SET
           promotion_record_sha256 = EXCLUDED.promotion_record_sha256,
           policy_revision = student_analytics_promotion.policy_revision + 1,
           feature_allowlist = EXCLUDED.feature_allowlist,
           starts_at = EXCLUDED.starts_at,
           expires_at = EXCLUDED.expires_at,
           revoked_at = NULL
         RETURNING policy_revision`,
        [grant.roomId, grant.promotionRecordSha256, [...grant.featureAllowlist],
          grant.startsAt, grant.expiresAt],
      );
      const revision = Number(result.rows[0]!.policy_revision);
      const after = new Set(grant.featureAllowlist);
      const changedKeys = STUDENT_PROJECTION_KEYS.filter(
        (key) => before.has(key) !== after.has(key),
      );
      return this.#notify(tx, { roomId: grant.roomId, changedKeys, revision });
    });
  }

  /**
   * Withdraw student visibility. Content-free: the row keeps only the digest
   * and scope it already had, and gains a revocation timestamp.
   */
  async revoke(roomId: string): Promise<PolicyChangeNotice> {
    if (!UUID.test(roomId)) throw new StudentPromotionError("STUDENT_PROMOTION_RECORD_INVALID");
    return inTransaction(this.pool, async (tx) => {
      const before = await this.#currentKeys(tx, roomId);
      const result = await tx.query<{ policy_revision: string }>(
        `UPDATE student_analytics_promotion
         SET revoked_at = coalesce(revoked_at, transaction_timestamp()),
             policy_revision = policy_revision + 1
         WHERE room_id = $1
         RETURNING policy_revision`,
        [roomId],
      );
      const row = result.rows[0];
      if (!row) throw new StudentPromotionError("STUDENT_PROMOTION_NOT_FOUND");
      return this.#notify(tx, {
        roomId,
        changedKeys: STUDENT_PROJECTION_KEYS.filter((key) => before.has(key)),
        revision: Number(row.policy_revision),
      });
    });
  }

  /** The keys a student may currently be shown; empty unless a live row says otherwise. */
  async currentAllowlist(roomId: string): Promise<ReadonlySet<StudentProjectionKey>> {
    if (!UUID.test(roomId)) return new Set();
    return inTransaction(this.pool, async (tx) => this.#currentKeys(tx, roomId));
  }

  async #currentKeys(tx: PoolClient, roomId: string): Promise<Set<StudentProjectionKey>> {
    const result = await tx.query<{ feature_allowlist: string[] }>(
      `SELECT feature_allowlist FROM student_analytics_promotion
       WHERE room_id = $1
         AND revoked_at IS NULL
         AND starts_at <= transaction_timestamp()
         AND expires_at > transaction_timestamp()`,
      [roomId],
    );
    const allowlist = result.rows[0]?.feature_allowlist ?? [];
    return new Set(allowlist.filter(
      (key): key is StudentProjectionKey => STUDENT_PROJECTION_KEYS.includes(key as StudentProjectionKey),
    ));
  }

  async #notify(tx: PoolClient, notice: PolicyChangeNotice): Promise<PolicyChangeNotice> {
    const payload = Buffer.from(canonicalJson({
      roomId: notice.roomId,
      changedKeys: [...notice.changedKeys],
      revision: notice.revision,
    })).toString("utf8");
    if (Buffer.byteLength(payload, "utf8") > MAX_NOTIFY_BYTES) {
      throw new StudentPromotionError("STUDENT_POLICY_NOTICE_INVALID");
    }
    // Committed with the row: a change is never announced that did not happen,
    // and a lost announcement is recovered by reconciliation rather than by
    // trusting the channel.
    await tx.query(`SELECT pg_notify($1, $2)`, [POLICY_CHANGE_CHANNEL, payload]);
    return Object.freeze({ ...notice, changedKeys: Object.freeze([...notice.changedKeys]) });
  }
}
