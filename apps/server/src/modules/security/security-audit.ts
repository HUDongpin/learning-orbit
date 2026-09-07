import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

export const AUDITED_ACTIONS = Object.freeze([
  "room.read",
  "room.command",
  "analytics.read",
  "export.request",
  "deletion.request",
  "deletion.status.read",
  "service.callback",
] as const);

export type AuditedAction = (typeof AUDITED_ACTIONS)[number];
export type AuditOutcome = "allowed" | "rejected" | "failed";
export type AuditPrincipalKind = "teacher" | "student" | "service" | "anonymous";

export interface SecurityAuditEntry {
  readonly principalKind: AuditPrincipalKind;
  readonly action: AuditedAction;
  readonly outcome: AuditOutcome;
  /** Bounded, upper-case; never a message, path, identifier or free text. */
  readonly reasonCode: string;
  readonly correlationId: string;
  /** Hashed with the audit salt before storage; the plain ID is never written. */
  readonly roomId?: string | null;
}

/** A room is referenced by a salted digest, so the log names no room it audits. */
export function roomRefHash(roomId: string, auditSalt: string): string {
  return createHash("sha256").update(`${auditSalt}:room:${roomId}`).digest("hex");
}

function normalizeReasonCode(value: string): string {
  const code = value.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
  return code.length > 0 ? code : "UNSPECIFIED";
}

/**
 * The one writer of the authorization audit trail.
 *
 * It used to live inside the governance service, so only deletion and export
 * were ever recorded: five of the seven actions the schema defines had no
 * writer at all, and an authorization decision on a room read, a chat command,
 * an analytics read or a worker callback left no trace either way. An audit
 * trail that records only the two rarest actions cannot answer the question it
 * exists for.
 *
 * Every entry is content-free by construction: a hashed room reference, a
 * bounded reason code, and nothing else. Recording must never be able to fail
 * the request it is recording, so a write failure is swallowed here rather
 * than turning an allowed action into an error.
 */
export class SecurityAuditLog {
  constructor(
    private readonly pool: Pool,
    private readonly auditSalt: string,
  ) {}

  async record(entry: SecurityAuditEntry): Promise<void> {
    try {
      await this.write(this.pool, entry);
    } catch {
      // An unrecorded decision must not become a failed one.
    }
  }

  /** Record inside a caller's transaction, where the row must commit with it. */
  async write(client: Pool | PoolClient, entry: SecurityAuditEntry): Promise<void> {
    if (!AUDITED_ACTIONS.includes(entry.action)) throw new Error("SECURITY_AUDIT_ACTION_INVALID");
    await client.query(
      `INSERT INTO security_audit_event(
         security_audit_event_id, correlation_id, principal_kind, action,
         outcome, reason_code, room_ref_sha256)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        entry.correlationId,
        entry.principalKind,
        entry.action,
        entry.outcome,
        normalizeReasonCode(entry.reasonCode),
        entry.roomId ? roomRefHash(entry.roomId, this.auditSalt) : null,
      ],
    );
  }
}
