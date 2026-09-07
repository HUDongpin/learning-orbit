import type { Pool, PoolClient } from "pg";

import {
  lifecycleInternalMediaSurfaceContract,
  type LifecycleInternalMediaSurfaceRequest,
  type LifecycleInternalMediaSurfaceResponse,
} from "@learning-orbit/contracts";

import type { Clock } from "../../clock.js";
import { inTransaction } from "../../db/transactions.js";
import { JobClaimAuthority, type JobClaimIdentity } from "../jobs/job-claim-authority.js";
import { lockRoomInTransaction } from "../rooms/room-lock.js";
import {
  authorizeServiceAssertion,
  verifyServiceAssertionEnvelope,
  type ServiceAssertionTrust,
} from "../security/service-assertion.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Physical removal of stored objects. Deletion cannot honestly complete
 * without one, so its absence is a retryable outcome rather than a silent
 * success.
 */
export interface MediaSurfaceEraser {
  /** Remove every stored object for the room; resolves only once absence is proven. */
  eraseRoomObjects(roomId: string, objectKeys: readonly string[]): Promise<void>;
}

const RETRY_AFTER_MS = 30_000;

/**
 * The return leg of media deletion.
 *
 * The Python lifecycle worker drives the deletion saga, but the media surface
 * itself is owned by TypeScript: the grants, write fences and object keys all
 * live here. This route is where the worker hands that surface back, and it is
 * the only place a `media` surface may be marked verified.
 *
 * It refuses to claim more than it can prove. Rows are removed only after every
 * in-flight media job and write fence is quiescent, and only after a configured
 * eraser has confirmed the stored objects are gone. With no eraser injected -
 * the state of this checkout - a room holding any media stays retryable
 * forever rather than issuing a receipt that would assert a remote deletion
 * nobody performed.
 */
export class InternalMediaSurfaceRoute {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
    private readonly trust: ServiceAssertionTrust,
    private readonly claims: JobClaimAuthority = new JobClaimAuthority(),
    private readonly eraser?: MediaSurfaceEraser,
  ) {}

  async handle(
    rawAssertion: unknown,
    value: unknown,
  ): Promise<LifecycleInternalMediaSurfaceResponse> {
    // Assertion before parse: an unsigned caller never reaches the generated
    // validator, so schema behaviour cannot be probed without a trusted key.
    let signedBy: string;
    try {
      signedBy = verifyServiceAssertionEnvelope(rawAssertion, value, {
        audience: "internal.lifecycle.mediaSurface",
      }, this.trust, this.clock.now());
    } catch {
      return { status: "rejected", code: "SERVICE_ASSERTION_INVALID" };
    }
    let request: LifecycleInternalMediaSurfaceRequest;
    try {
      request = lifecycleInternalMediaSurfaceContract.parseRequest(value);
    } catch {
      return { status: "rejected", code: "LIFECYCLE_SURFACE_IDENTITY_INVALID" };
    }
    const claim: JobClaimIdentity = request;
    try {
      if (request.workerId !== signedBy) throw new Error("SERVICE_ASSERTION_INVALID");
      authorizeServiceAssertion(rawAssertion, request, {
        audience: "internal.lifecycle.mediaSurface",
        workerId: request.workerId,
        claim,
      }, this.trust, this.clock.now());
    } catch {
      return { status: "rejected", code: "SERVICE_ASSERTION_INVALID" };
    }

    const retryable = (code: "MEDIA_SURFACE_NOT_QUIESCENT" | "MEDIA_SURFACE_STORE_UNAVAILABLE") => ({
      status: "retryable" as const,
      code,
      notBefore: new Date(this.clock.now().getTime() + RETRY_AFTER_MS).toISOString(),
    });

    try {
      return await inTransaction(this.pool, async (tx) => {
        const jobResult = await tx.query<{
          job_type: string;
          room_id: string | null;
          source_event_id: string | null;
          dedupe_key: string;
          correlation_id: string;
          payload: unknown;
        }>(
          `SELECT job_type, room_id, source_event_id, dedupe_key, correlation_id, payload
           FROM worker_job WHERE job_id = $1 FOR UPDATE`,
          [request.jobId],
        );
        const job = jobResult.rows[0];
        const payload = isPlainRecord(job?.payload) ? job.payload : undefined;
        const identityOk = !!job
          && job.job_type === request.jobType
          && job.room_id === null
          && job.source_event_id === null
          && job.dedupe_key === request.dedupeKey
          && job.correlation_id === request.correlationId
          && !!payload
          && payload.deletionJobId === request.deletionJobId
          && payload.surface === request.surface;
        if (!identityOk) return { status: "rejected", code: "LIFECYCLE_SURFACE_IDENTITY_INVALID" };

        try {
          await this.claims.requireCurrent(tx, claim);
        } catch {
          return { status: "rejected", code: "JOB_CLAIM_STALE" };
        }

        const deletion = await tx.query<{ room_id: string | null; status: string }>(
          `SELECT room_id, status FROM deletion_job WHERE deletion_job_id = $1 FOR UPDATE`,
          [request.deletionJobId],
        );
        const deletionJob = deletion.rows[0];
        if (!deletionJob) return { status: "rejected", code: "LIFECYCLE_SURFACE_IDENTITY_INVALID" };

        const manifest = await tx.query<{ status: string; expected_item_count: number }>(
          `SELECT status, expected_item_count FROM deletion_surface_manifest
           WHERE deletion_job_id = $1 AND surface = 'media' FOR UPDATE`,
          [request.deletionJobId],
        );
        const surface = manifest.rows[0];
        if (!surface) return { status: "rejected", code: "LIFECYCLE_SURFACE_IDENTITY_INVALID" };
        if (surface.status === "verified") {
          await this.claims.completeBusiness(tx, claim, "MEDIA_SURFACE_VERIFIED");
          return {
            status: "already_verified",
            surface: "media",
            verifiedItemCount: surface.expected_item_count,
          };
        }

        // The room row survives until the whole saga finishes, so a media
        // surface whose room is already gone is a deletion that ran out of
        // order rather than one that finished early.
        const roomId = deletionJob.room_id;
        if (roomId === null) return { status: "rejected", code: "LIFECYCLE_SURFACE_IDENTITY_INVALID" };
        await lockRoomInTransaction(tx, roomId);

        const quiescence = await this.assertQuiescent(tx, roomId);
        if (!quiescence.quiet) return retryable("MEDIA_SURFACE_NOT_QUIESCENT");

        const assets = await tx.query<{ media_id: string; object_key: string | null }>(
          `SELECT media_id, object_key FROM media_asset WHERE room_id = $1 FOR UPDATE`,
          [roomId],
        );
        const derivatives = await tx.query<{ object_key: string }>(
          `SELECT d.object_key FROM media_derivative d
           JOIN media_asset m ON m.media_id = d.media_id
           WHERE m.room_id = $1`,
          [roomId],
        );
        const objectKeys = [
          ...assets.rows.map(({ object_key: key }) => key).filter((key): key is string => key !== null),
          ...derivatives.rows.map(({ object_key: key }) => key),
        ];

        if (objectKeys.length > 0) {
          if (!this.eraser) return retryable("MEDIA_SURFACE_STORE_UNAVAILABLE");
          try {
            await this.eraser.eraseRoomObjects(roomId, objectKeys);
          } catch {
            return retryable("MEDIA_SURFACE_STORE_UNAVAILABLE");
          }
        }

        // Dependency order: fences and grants reference the assets, and the
        // attachment binding references both the asset and its source event.
        await tx.query(
          `DELETE FROM media_write_fence WHERE room_id = $1`,
          [roomId],
        );
        await tx.query(
          `DELETE FROM media_upload_grant WHERE room_id = $1`,
          [roomId],
        );
        await tx.query(
          `DELETE FROM media_attachment_binding WHERE room_id = $1`,
          [roomId],
        );
        const removed = await tx.query(
          `DELETE FROM media_asset WHERE room_id = $1`,
          [roomId],
        );

        await tx.query(
          `UPDATE deletion_surface_manifest
           SET status = 'verified', verified_at = transaction_timestamp()
           WHERE deletion_job_id = $1 AND surface = 'media'`,
          [request.deletionJobId],
        );
        await this.claims.completeBusiness(tx, claim, "MEDIA_SURFACE_VERIFIED");
        return {
          status: "completed",
          surface: "media",
          verifiedItemCount: removed.rowCount ?? 0,
        };
      });
    } catch (error) {
      if (error instanceof Error && error.message === "JOB_CLAIM_STALE") {
        return { status: "rejected", code: "JOB_CLAIM_STALE" };
      }
      throw error;
    }
  }

  /**
   * An object write that is already signed, or a copy whose outcome is
   * unknown, may still land after the rows are gone. Deleting under either
   * would leave an orphan nobody can find again, so both hold the surface.
   */
  private async assertQuiescent(tx: PoolClient, roomId: string): Promise<{ quiet: boolean }> {
    const jobs = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM worker_job
       WHERE room_id = $1
         AND job_type IN ('media.process.v1','media.reconcile-upload.v1')
         AND status IN ('queued','retryable','running')`,
      [roomId],
    );
    const fences = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM media_write_fence
       WHERE room_id = $1 AND state IN ('active','uncertain')
         AND write_not_after > transaction_timestamp()`,
      [roomId],
    );
    const grants = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM media_upload_grant
       WHERE room_id = $1 AND state IN ('issuing','active')
         AND greatest(write_not_after, coalesce(promotion_write_not_after, write_not_after))
             > transaction_timestamp()`,
      [roomId],
    );
    return {
      quiet: jobs.rows[0]?.count === "0"
        && fences.rows[0]?.count === "0"
        && grants.rows[0]?.count === "0",
    };
  }
}
