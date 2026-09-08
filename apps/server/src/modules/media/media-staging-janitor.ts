import type { Pool, PoolClient } from "pg";

import type { Clock } from "../../clock.js";
import { inTransaction } from "../../db/transactions.js";
import { lockRoomInTransaction } from "../rooms/room-lock.js";
import type { MediaStore } from "./media-store.js";

export interface JanitorSweepResult {
  readonly grantsClosed: number;
  readonly stagingObjectsRemoved: number;
  readonly abandonedObjectsRemoved: number;
  readonly abandonedRowsRemoved: number;
  readonly deferred: number;
}

/**
 * A grant selected before the room lock, so it carries only what stays true
 * while stale: identity, and the staging key whose fence the selecting query
 * already proved past.
 *
 * Every fact the abandoned branch decides on - the media's state, its failure
 * code, the promotion destination - is deliberately absent here and read again
 * under the lock. Each of them can change between this SELECT and that lock,
 * and one of them names an object that gets deleted, so a snapshot must not be
 * able to reach the decision at all.
 */
interface CandidateGrant {
  grant_id: string;
  media_id: string;
  room_id: string;
  object_key: string;
}

/** The ledger as it actually is: both rows read under the room lock. */
interface LockedView {
  readonly grantState: string;
  readonly pastFence: boolean;
  readonly destinationKey: string | null;
  readonly mediaState: string;
  readonly mediaFailureCode: string | null;
  readonly mediaObjectKey: string | null;
}

/**
 * What the locked ledger permits this sweep to do with an abandoned promotion.
 * `object` is the only verdict that authorises a delete against the store, and
 * the key it carries comes from the locked grant row, never the candidate.
 */
type AbandonVerdict =
  | { readonly kind: "keep" }
  | { readonly kind: "rows_only" }
  | { readonly kind: "object"; readonly destinationKey: string };

const DEFAULT_BATCH = 25;
const STORE_TIMEOUT_MS = 15_000;
/** S3 caps a key at 1024 bytes; a longer one cannot be an object we wrote. */
const MAX_OBJECT_KEY_BYTES = 1_024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/**
 * Sweep staging objects whose write fence has expired, and retire the ledger
 * rows of promotions that were abandoned.
 *
 * A signed PUT stays usable until its fence passes, so removing the staging
 * key one millisecond early would delete an object the client is still
 * entitled to write - and a client that then completed its PUT would leave an
 * object no row points at. The fence is therefore read from the database, in
 * the database's own clock, and never from application time.
 *
 * What it may reach, stated narrowly because the wider claim is not true. A
 * promoted immutable original is normally none of this sweep's business:
 * governed room deletion and retention own it. The one exception is an
 * original whose promotion was abandoned - the reconcile job could not observe
 * the destination at the settlement fence, marked the asset `failed` /
 * `PROMOTION_ABANDONED`, and has since durably finished. Abandoned means the
 * copy was not observed, not that it was proven absent; a transport failure
 * marks abandoned too, so those bytes may well be sitting there. Retiring the
 * grant and asset rows destroys the only pointers to them, because the
 * deletion surface builds its erase list out of exactly those rows, and the
 * object would then outlive every later room deletion while the receipt still
 * said `completed`. So this sweep owns that object, and may retire the rows
 * only once it is proven gone.
 *
 * The invariant that gives the ordering below its shape runs one way: rows may
 * outlive the object, the object may never outlive the rows. A sweep that
 * stops half way leaves rows naming an object that is already gone, which the
 * next room deletion erases idempotently and reports honestly. The reverse -
 * rows gone, object alive - is the state this ordering exists to make
 * unreachable, so every failure here keeps the rows.
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
      `SELECT g.grant_id, g.media_id, g.room_id, g.object_key
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
    let abandonedObjectsRemoved = 0;
    let abandonedRowsRemoved = 0;
    let deferred = 0;

    for (const candidate of await this.#candidates()) {
      // The store call cannot happen inside the transaction: a slow provider
      // would hold the room lock for its whole timeout. Remove the object
      // first, then close the ledger under the lock. Removing an object whose
      // grant is not closed afterwards is safe and re-runnable; closing a
      // ledger whose object still exists is not.
      try {
        await this.store.deleteObjects([candidate.object_key], this.#control());
      } catch {
        // Leave the fence open; the next sweep retries. A staging object that
        // cannot be proven gone must not let its grant close.
        deferred += 1;
        continue;
      }
      stagingObjectsRemoved += 1;

      // Lock 1. Close the ledger, then decide - on rows held under the lock,
      // never on the candidate snapshot - whether this media's promoted
      // destination is this sweep's to remove.
      let decision: AbandonVerdict | "deferred";
      try {
        decision = await inTransaction(this.pool, async (tx) => {
          await lockRoomInTransaction(tx, candidate.room_id);
          const view = await this.#lockedView(tx, candidate);
          // The fence may have been extended between selection and the lock.
          if (!view || !view.pastFence) return "deferred" as const;

          if (view.grantState !== "closed") {
            await tx.query(
              `UPDATE media_upload_grant
               SET state = 'closed', closed_at = coalesce(closed_at, transaction_timestamp())
               WHERE grant_id = $1`,
              [candidate.grant_id],
            );
          }

          const verdict = await this.#abandonVerdict(tx, candidate, view);
          // Rows that name no destination object can go here and now: there is
          // nothing for them to orphan, so there is nothing to prove first.
          if (verdict.kind === "rows_only") await this.#deleteAbandonedRows(tx, candidate, null);
          return verdict;
        });
      } catch {
        // The close did not commit, so nothing downstream of it may run.
        deferred += 1;
        continue;
      }
      if (decision === "deferred") { deferred += 1; continue; }
      grantsClosed += 1;
      if (decision.kind === "keep") continue;
      if (decision.kind === "rows_only") { abandonedRowsRemoved += 1; continue; }

      // The one key this candidate is authorised to erase, fixed here so the
      // erase and the re-check below cannot end up talking about two.
      const authorisedKey = decision.destinationKey;

      // The lock is released before the store is touched again, for the same
      // reason as staging: a provider that hangs must not hold a classroom's
      // room lock for its whole timeout. `deleteObjects` resolves only on
      // proven absence - it deletes the exact key and then requires 404 from a
      // verifying HEAD - so reaching the next line is the proof the rows need.
      try {
        await this.store.deleteObjects([authorisedKey], this.#control());
      } catch {
        // No proof, so no row deletion. The rows stay, still naming the
        // object, and the next sweep asks again from the top.
        deferred += 1;
        continue;
      }
      abandonedObjectsRemoved += 1;

      // Lock 2. The object is gone; the rows may follow only if the ledger
      // still says exactly what it said when the erase was authorised.
      let finished: "removed" | "deferred";
      try {
        finished = await inTransaction(this.pool, async (tx) => {
          await lockRoomInTransaction(tx, candidate.room_id);
          const view = await this.#lockedView(tx, candidate);
          if (!view || !view.pastFence) return "deferred" as const;
          const verdict = await this.#abandonVerdict(tx, candidate, view);
          // Same predicate, same answer, same key. Anything else means the
          // ledger moved under the erase, and the safe direction to fail in is
          // rows outliving their object.
          if (verdict.kind !== "object" || verdict.destinationKey !== authorisedKey) {
            return "deferred" as const;
          }
          await this.#deleteAbandonedRows(tx, candidate, verdict.destinationKey);
          return "removed" as const;
        });
      } catch {
        deferred += 1;
        continue;
      }
      if (finished === "removed") abandonedRowsRemoved += 1;
      else deferred += 1;
    }

    return {
      grantsClosed,
      stagingObjectsRemoved,
      abandonedObjectsRemoved,
      abandonedRowsRemoved,
      deferred,
    };
  }

  /**
   * Both rows for one candidate, held for the rest of the transaction.
   *
   * Asset before grant, which is the order every room-scoped media write path
   * takes, so this sweep cannot be the one that closes a cycle. The room
   * advisory lock is already held and serialises those paths on its own; the
   * row locks keep this read in the same discipline rather than relying on
   * that alone.
   */
  async #lockedView(tx: PoolClient, candidate: CandidateGrant): Promise<LockedView | null> {
    const asset = await tx.query<{
      state: string;
      failure_code: string | null;
      object_key: string | null;
    }>(
      `SELECT state::text AS state, failure_code, object_key
       FROM media_asset WHERE media_id = $1 AND room_id = $2 FOR UPDATE`,
      [candidate.media_id, candidate.room_id],
    );
    const grant = await tx.query<{
      state: string;
      past_fence: boolean;
      promotion_destination_key: string | null;
    }>(
      `SELECT state::text AS state, promotion_destination_key,
              greatest(write_not_after, coalesce(promotion_write_not_after, write_not_after))
                <= transaction_timestamp() AS past_fence
       FROM media_upload_grant WHERE grant_id = $1 FOR UPDATE`,
      [candidate.grant_id],
    );
    const media = asset.rows[0];
    const held = grant.rows[0];
    if (!media || !held) return null;
    return {
      grantState: held.state,
      pastFence: held.past_fence,
      destinationKey: held.promotion_destination_key,
      mediaState: media.state,
      mediaFailureCode: media.failure_code,
      mediaObjectKey: media.object_key,
    };
  }

  /**
   * What may be done with an abandoned promotion, asked entirely of rows held
   * under the room lock.
   *
   * Called twice per candidate with one body - once to authorise the erase,
   * once after it to authorise the row deletion - because "still abandoned,
   * settled and unchanged" only means something if the second question is
   * literally the same question as the first.
   */
  async #abandonVerdict(
    tx: PoolClient,
    candidate: CandidateGrant,
    view: LockedView,
  ): Promise<AbandonVerdict> {
    if (view.mediaState !== "failed" || view.mediaFailureCode !== "PROMOTION_ABANDONED") {
      return { kind: "keep" };
    }
    // An asset that names an object is one a promotion committed for, whatever
    // its failure code now says. The two facts contradict each other, and a
    // contradiction is not a licence to delete.
    if (view.mediaObjectKey !== null) return { kind: "keep" };
    // An abandoned promotion keeps its rows until the reconcile job that owns
    // the retry is durably finished. Removing them earlier would destroy the
    // only target a lost internal-route response could retry against - and
    // that job is also the sole writer that could still turn this destination
    // into a live original, since the reconcile route acts only on a job it
    // can claim as running and the promotion path enqueues one only for an
    // asset still `upload_pending`. Its absence, under this room's lock, is
    // what makes the erase below safe rather than merely likely.
    if (!(await this.#reconcileSettled(tx, candidate.media_id))) return { kind: "keep" };
    if (view.destinationKey === null) {
      // No promotion was ever recorded against this grant, so the rows name no
      // second object and retiring them orphans nothing.
      return { kind: "rows_only" };
    }
    const destinationKey = this.#erasableDestinationKey(candidate, view.destinationKey);
    if (destinationKey === null) return { kind: "keep" };
    // `media_asset.object_key` is set only when a promotion commits and the
    // column is unique, so this is exactly the question "does a live asset use
    // these bytes". It is asked under this room's lock about a key just proven
    // to address this room, so no writer outside this lock can answer it
    // differently a moment later.
    const claimed = await tx.query<{ claimed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM media_asset WHERE object_key = $1) AS claimed`,
      [destinationKey],
    );
    if (claimed.rows[0]?.claimed !== false) return { kind: "keep" };
    return { kind: "object", destinationKey };
  }

  /**
   * The stored destination key, returned only once the row is proven to name
   * this room's promoted original.
   *
   * The rule is the deletion surface eraser's, for its reason: every key this
   * system writes is `rooms/{roomId}/...`, so the key is an invariant to
   * re-derive rather than a label to trust, and a mislabelled or tampered row
   * must never become a delete against another classroom's objects.
   *
   * The whole key is re-derived, not just the room half. `media-service.ts`
   * builds a promoted original as `rooms/{roomId}/original/{mediaId}` and
   * nothing else ever writes that column, so both halves are known here. A
   * room-only check left the media half untrusted, and a row naming a
   * *sibling* media's original - same classroom, so same prefix - passed it:
   * that original is still `upload_pending`, so its asset row has not claimed
   * `object_key` yet and the live-use query below cannot see it either. The
   * result was erasing another student's in-flight upload. Unreachable from
   * application code, since `media_upload_grant.media_id` is unique and the
   * promotion path derives the key for its own media - but a row this method
   * declines to trust is exactly the row it exists to refuse.
   *
   * What comes back is the stored key itself, never a re-derived one. Proving
   * the absence of a key this method invented would prove nothing about the
   * key the row actually names, and it is the row's key that the deletion
   * surface would have erased.
   */
  #erasableDestinationKey(candidate: CandidateGrant, destinationKey: string): string | null {
    // The identity halves are read from the same row, so they are checked too:
    // a tampered room or media id must not be able to build its own target.
    const expected = `rooms/${candidate.room_id}/original/${candidate.media_id}`;
    if (destinationKey !== expected
      || destinationKey.includes("..")
      || CONTROL_CHARACTERS.test(destinationKey)
      || Buffer.byteLength(destinationKey, "utf8") > MAX_OBJECT_KEY_BYTES) {
      return null;
    }
    return destinationKey;
  }

  /**
   * Retire both rows, or neither.
   *
   * The grant goes first because `media_upload_grant.media_id` references the
   * asset `ON DELETE RESTRICT`. Both statements carry the identity the
   * decision was taken about, the grant's including the destination key, so a
   * grant that has acquired a different one cannot be removed by a decision
   * made about the old one. A miss on either aborts the transaction, which
   * leaves the pair intact rather than leaving one pointer standing.
   */
  async #deleteAbandonedRows(
    tx: PoolClient,
    candidate: CandidateGrant,
    destinationKey: string | null,
  ): Promise<void> {
    const grant = await tx.query(
      `DELETE FROM media_upload_grant
       WHERE grant_id = $1 AND media_id = $2 AND room_id = $3
         AND promotion_destination_key IS NOT DISTINCT FROM $4`,
      [candidate.grant_id, candidate.media_id, candidate.room_id, destinationKey],
    );
    const asset = await tx.query(
      `DELETE FROM media_asset WHERE media_id = $1 AND room_id = $2
         AND state = 'failed' AND failure_code = 'PROMOTION_ABANDONED'`,
      [candidate.media_id, candidate.room_id],
    );
    if (grant.rowCount !== 1 || asset.rowCount !== 1) {
      throw new Error("MEDIA_ABANDONED_LEDGER_UNSTABLE");
    }
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
