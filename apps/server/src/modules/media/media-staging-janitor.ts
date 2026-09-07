import type { Pool, PoolClient } from "pg";

import type { Clock } from "../../clock.js";
import { inTransaction } from "../../db/transactions.js";
import { lockRoomInTransaction } from "../rooms/room-lock.js";
import type { MediaStore } from "./media-store.js";

export interface JanitorSweepResult {
  readonly grantsClosed: number;
  readonly stagingObjectsRemoved: number;
  readonly abandonedRowsRemoved: number;
  readonly deferred: number;
}

interface CandidateGrant {
  grant_id: string;
  media_id: string;
  room_id: string;
  object_key: string;
  state: string;
  promotion_destination_key: string | null;
  media_state: string;
  media_failure_code: string | null;
}

const DEFAULT_BATCH = 25;
const STORE_TIMEOUT_MS = 15_000;

/**
 * Sweep staging objects whose write fence has expired.
 *
 * A signed PUT stays usable until its fence passes, so removing the staging
 * key one millisecond early would delete an object the client is still
 * entitled to write - and a client that then completed its PUT would leave an
 * object no row points at. The fence is therefore read from the database, in
 * the database's own clock, and never from application time.
 *
 * What it never touches: a promoted immutable original. Only the staging key
 * is removed. Governed room deletion and retention own the original, and this
 * sweep must not be able to reach it.
 */
export class MediaStagingJanitor {
  constructor(
    private readonly pool: Pool,
    private readonly store: MediaStore,
    private readonly clock: Clock,
    private readonly batchSize: number = DEFAULT_BATCH,
  ) {}

  #control() {
    const now = this.clock.now();
    return {
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
      deadline: new Date(now.getTime() + STORE_TIMEOUT_MS),
      now: () => this.clock.now(),
    };
  }

  /** Grants past their effective fence, newest room lock taken one at a time. */
  async #candidates(): Promise<CandidateGrant[]> {
    const result = await this.pool.query<CandidateGrant>(
      `SELECT g.grant_id, g.media_id, g.room_id, g.object_key, g.state::text AS state,
              g.promotion_destination_key,
              m.state::text AS media_state, m.failure_code AS media_failure_code
       FROM media_upload_grant g
       JOIN media_asset m ON m.media_id = g.media_id
       WHERE g.state <> 'expired'
         AND greatest(
               g.write_not_after,
               coalesce(g.promotion_write_not_after, g.write_not_after)
             ) <= transaction_timestamp()
       ORDER BY g.reserved_at ASC
       LIMIT $1`,
      [this.batchSize],
    );
    return result.rows;
  }

  async sweep(): Promise<JanitorSweepResult> {
    let grantsClosed = 0;
    let stagingObjectsRemoved = 0;
    let abandonedRowsRemoved = 0;
    let deferred = 0;

    for (const candidate of await this.#candidates()) {
      // The store call cannot happen inside the transaction: a slow provider
      // would hold the room lock for its whole timeout. Remove the object
      // first, then close the ledger under the lock. Removing an object whose
      // grant is not closed afterwards is safe and re-runnable; closing a
      // ledger whose object still exists is not.
      let removed = false;
      try {
        await this.store.deleteObjects([candidate.object_key], this.#control());
        removed = true;
      } catch {
        // Leave the fence open; the next sweep retries. A staging object that
        // cannot be proven gone must not let its grant close.
        deferred += 1;
        continue;
      }
      if (removed) stagingObjectsRemoved += 1;

      const outcome = await inTransaction(this.pool, async (tx) => {
        await lockRoomInTransaction(tx, candidate.room_id);
        const fresh = await tx.query<{
          state: string;
          past_fence: boolean;
        }>(
          `SELECT state::text AS state,
                  greatest(write_not_after, coalesce(promotion_write_not_after, write_not_after))
                    <= transaction_timestamp() AS past_fence
           FROM media_upload_grant WHERE grant_id = $1 FOR UPDATE`,
          [candidate.grant_id],
        );
        const grant = fresh.rows[0];
        // The fence may have been extended between selection and the lock.
        if (!grant || !grant.past_fence) return "deferred" as const;

        if (grant.state !== "closed") {
          await tx.query(
            `UPDATE media_upload_grant
             SET state = 'closed', closed_at = coalesce(closed_at, transaction_timestamp())
             WHERE grant_id = $1`,
            [candidate.grant_id],
          );
        }
        // An abandoned promotion keeps its rows until the reconcile job that
        // owns the retry is durably finished. Removing them earlier would
        // destroy the only target a lost internal-route response could retry
        // against.
        if (candidate.media_state === "failed"
          && candidate.media_failure_code === "PROMOTION_ABANDONED") {
          if (!(await this.#reconcileSettled(tx, candidate.media_id))) return "closed" as const;
          await tx.query(`DELETE FROM media_upload_grant WHERE grant_id = $1`, [candidate.grant_id]);
          await tx.query(
            `DELETE FROM media_asset WHERE media_id = $1 AND room_id = $2
               AND state = 'failed' AND failure_code = 'PROMOTION_ABANDONED'`,
            [candidate.media_id, candidate.room_id],
          );
          return "removed" as const;
        }
        return "closed" as const;
      });

      if (outcome === "deferred") deferred += 1;
      else if (outcome === "removed") { grantsClosed += 1; abandonedRowsRemoved += 1; }
      else grantsClosed += 1;
    }

    return { grantsClosed, stagingObjectsRemoved, abandonedRowsRemoved, deferred };
  }

  /** True once no reconcile job for this media can still be retried. */
  async #reconcileSettled(tx: PoolClient, mediaId: string): Promise<boolean> {
    const result = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM worker_job
       WHERE job_type = 'media.reconcile-upload.v1'
         AND dedupe_key = $1
         AND status IN ('queued', 'running', 'retryable')`,
      [`media.reconcile-upload.v1:${mediaId}`],
    );
    return result.rows[0]?.count === "0";
  }
}
