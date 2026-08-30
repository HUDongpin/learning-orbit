import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";

const sqlDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../db/sql");
const lockRoomInTransactionSql = readFileSync(resolve(sqlDirectory, "lock_room_xact.sql"), "utf8");
const lockRoomCodeAllocationSql = readFileSync(
  resolve(sqlDirectory, "lock_room_code_allocation.sql"),
  "utf8",
);
const lockRoomSessionSql = readFileSync(resolve(sqlDirectory, "lock_room_session.sql"), "utf8");
const unlockRoomSessionSql = readFileSync(resolve(sqlDirectory, "unlock_room_session.sql"), "utf8");

/**
 * Room-scoped writes must take locks in this order: canonical room advisory,
 * classroom_room FOR UPDATE, family rows by primary key, exact worker_job FOR
 * UPDATE, then the mutation/marker. Candidate job claiming only locks worker_job.
 * Room creation takes the canonical room-code allocation lock before checking
 * or inserting a candidate code; it has no room row to lock yet.
 */
export async function lockRoomInTransaction(tx: PoolClient, roomId: string): Promise<void> {
  await tx.query(lockRoomInTransactionSql, [roomId]);
}

export async function lockRoomCodeAllocationInTransaction(
  tx: PoolClient,
  normalizedCode: string,
): Promise<void> {
  await tx.query(lockRoomCodeAllocationSql, [normalizedCode]);
}

export async function withRoomSessionLock<T>(
  pool: Pool,
  roomId: string,
  work: (connection: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let acquired = false;
  let poisonConnection = false;
  let callbackError: unknown;
  let result: T | undefined;

  try {
    await client.query(lockRoomSessionSql, [roomId]);
    acquired = true;
    result = await work(client);
  } catch (error) {
    callbackError = error;
  } finally {
    if (acquired) {
      try {
        const unlock = await client.query<{ pg_advisory_unlock: boolean }>(unlockRoomSessionSql, [roomId]);
        if (unlock.rows[0]?.pg_advisory_unlock !== true) {
          poisonConnection = true;
          throw new Error("ROOM_SESSION_UNLOCK_FAILED");
        }
      } catch (unlockError) {
        poisonConnection = true;
        if (callbackError) {
          throw new AggregateError([callbackError, unlockError], "ROOM_SESSION_LOCK_CALLBACK_AND_UNLOCK_FAILED");
        }
        throw unlockError;
      } finally {
        client.release(poisonConnection);
      }
    } else {
      client.release(poisonConnection);
    }
  }

  if (callbackError) throw callbackError;
  return result as T;
}
