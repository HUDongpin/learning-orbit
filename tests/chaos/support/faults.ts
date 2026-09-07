/**
 * Deterministic fault injection for the chaos suite.
 *
 * The faults are driven in-process rather than by restarting containers. What
 * a scenario needs to prove is that durable state survives losing a process,
 * and that is decided by what was committed before the loss — not by whether
 * the loss came from `docker restart` or from closing the app. Building the
 * server again against the same database reproduces the same starting
 * condition in about a second instead of about a minute, which is the
 * difference between a suite that runs on every change and one that does not.
 *
 * What this deliberately does not simulate: a partial write. Every scenario
 * loses the process at a transaction boundary, because the database is what
 * makes any other loss impossible, and pretending otherwise would test a
 * failure mode the system cannot have.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../../../apps/server/src/app.js";
import type { createDatabasePool } from "../../../apps/server/src/db/pool.js";

type Pool = ReturnType<typeof createDatabasePool>;

export interface ChaosServer {
  app: FastifyInstance;
  /** Lose the process and start a new one against the same database. */
  restart(): Promise<ChaosServer>;
  close(): Promise<void>;
}

export interface ChaosOptions {
  databaseUrl: string;
  allowedOrigin?: string;
}

export async function startChaosServer(options: ChaosOptions): Promise<ChaosServer> {
  const allowedOrigin = options.allowedOrigin ?? "https://app.learning-orbit.test";
  const app = await buildApp({
    databaseUrl: options.databaseUrl,
    config: { allowedOrigins: [allowedOrigin], publicBaseOrigin: allowedOrigin },
  });
  const server: ChaosServer = {
    app,
    async restart() {
      await app.close();
      return startChaosServer(options);
    },
    async close() {
      await app.close();
    },
  };
  return server;
}

/** Arm a fault through the same route a real scenario would use. */
export async function arm(app: FastifyInstance, name: string, value: unknown): Promise<unknown> {
  const response = await app.inject({
    method: "POST",
    url: `/test/faults/${name}`,
    payload: { value },
  });
  if (response.statusCode !== 200) throw new Error(`FAULT_ARM_FAILED:${response.statusCode}`);
  return response.json();
}

export async function resetFaults(app: FastifyInstance): Promise<void> {
  await app.inject({ method: "DELETE", url: "/test/faults" });
}

/**
 * Every event committed in a room, in sequence order.
 *
 * Read straight from the ledger rather than through an API, because the
 * question a chaos scenario asks is what survived, and an API answer could be
 * served from something that did not.
 */
export async function committedEvents(
  pool: Pool,
  roomId: string,
): Promise<Array<{ eventId: string; roomSeq: number; causationId: string }>> {
  const result = await pool.query<{ event_id: string; room_seq: string; causation_id: string }>(
    "SELECT event_id, room_seq, causation_id FROM room_event WHERE room_id=$1 ORDER BY room_seq",
    [roomId],
  );
  return result.rows.map((row) => ({
    eventId: row.event_id,
    roomSeq: Number(row.room_seq),
    causationId: row.causation_id,
  }));
}

export async function unpublishedOutbox(pool: Pool, roomId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM outbox_event WHERE room_id=$1 AND published_at IS NULL",
    [roomId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

export async function publishedOutbox(pool: Pool, roomId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM outbox_event WHERE room_id=$1 AND published_at IS NOT NULL",
    [roomId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

/**
 * Write one deterministic evidence record per scenario.
 *
 * A chaos run that only says "passed" is not evidence. These records name the
 * fault, what survived it, and the counts that decided the verdict.
 */
export interface ChaosEvidence {
  scenario: string;
  fault: string;
  committed: number;
  delivered: number;
  duplicated: number;
  lost: number;
}

export function chaosVerdict(evidence: ChaosEvidence): ChaosEvidence & { ok: boolean } {
  return { ...evidence, ok: evidence.lost === 0 && evidence.duplicated === 0 };
}

export function chaosRunId(): string {
  return randomUUID();
}
