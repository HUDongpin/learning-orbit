import type { Clock } from "../../clock.js";
import { JobClaimAuthority, type JobClaimIdentity } from "../jobs/job-claim-authority.js";
import { authorizeServiceAssertion, type ServiceAssertionTrust } from "../security/service-assertion.js";
import { MediaRepository } from "./media-repository.js";
import type { MediaStore } from "./media-store.js";
import { mediaInternalReconcileContract, type MediaInternalReconcileRequest, type MediaInternalReconcileResponse } from "@learning-orbit/contracts";
import { MediaError } from "./media-errors.js";
import { effectiveWriteNotAfter } from "./media-upload-expiry.js";

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export class MediaInternalReconcileRoute {
  constructor(
    private readonly events: import("../rooms/room-event-repository.js").RoomEventRepository,
    private readonly repo: MediaRepository,
    private readonly store: MediaStore,
    private readonly clock: Clock,
    private readonly trust: ServiceAssertionTrust,
    private readonly claims: JobClaimAuthority = new JobClaimAuthority(),
  ) {}

  async handle(rawAssertion: unknown, value: unknown): Promise<MediaInternalReconcileResponse> {
    let request: MediaInternalReconcileRequest;
    try {
      request = mediaInternalReconcileContract.parseRequest(value);
    } catch {
      return { status: "rejected", code: "MEDIA_JOB_IDENTITY_MISMATCH" };
    }
    const claim: JobClaimIdentity = request;
    try {
      authorizeServiceAssertion(rawAssertion, request, {
        audience: "internal.media.reconcileUpload",
        workerId: request.workerId,
        claim,
      }, this.trust, this.clock.now());
    } catch {
      return { status: "rejected", code: "SERVICE_ASSERTION_INVALID" };
    }

    try {
      return await this.events.transact(request.roomId, async (context) => {
        const tx = context.client;
        const jobResult = await tx.query<{
          job_id: string;
          job_type: string;
          room_id: string | null;
          source_event_id: string | null;
          dedupe_key: string;
          correlation_id: string;
          payload: unknown;
          status: string;
        }>(
          `SELECT job_id, job_type, room_id, source_event_id, dedupe_key,
                  correlation_id, payload, status
           FROM worker_job WHERE job_id = $1 FOR UPDATE`,
          [request.jobId],
        );
        const job = jobResult.rows[0];
        const payload = plainRecord(job?.payload) ? job.payload : undefined;
        const identityOk = !!job
          && job.job_type === request.jobType
          && job.room_id === request.roomId
          && job.source_event_id === null
          && job.dedupe_key === request.dedupeKey
          && job.correlation_id === request.correlationId
          && !!payload
          && Object.keys(payload).length === 1
          && payload.mediaId === request.mediaId;
        if (!identityOk) return { status: "rejected", code: "MEDIA_JOB_IDENTITY_MISMATCH" };
        try {
          await this.claims.requireCurrent(tx, claim);
        } catch {
          return { status: "rejected", code: "JOB_CLAIM_STALE" };
        }

        const mediaResult = await tx.query<{
          media_id: string;
          room_id: string;
          owner_actor_id: string;
          state: string;
          object_key: string | null;
          sha256: string | null;
          size_bytes: string;
          promotion_correlation_id: string | null;
        }>(
          `SELECT media_id, room_id, owner_actor_id, state, object_key,
                  sha256, size_bytes, promotion_correlation_id
           FROM media_asset WHERE media_id = $1 AND room_id = $2 FOR UPDATE`,
          [request.mediaId, request.roomId],
        );
        const media = mediaResult.rows[0];
        const grant = media ? await this.repo.lockGrantForMedia(tx, request.mediaId, request.roomId) : null;
        if (!media || !grant || (grant.promotionCorrelationId && grant.promotionCorrelationId !== request.correlationId)) {
          return { status: "rejected", code: "MEDIA_JOB_IDENTITY_MISMATCH" };
        }
        if (!grant.promotionCorrelationId && media.promotion_correlation_id && media.promotion_correlation_id !== request.correlationId) {
          return { status: "rejected", code: "MEDIA_JOB_IDENTITY_MISMATCH" };
        }
        if (media.object_key && media.sha256 && ["uploaded", "processing", "ready"].includes(media.state)) {
          await this.claims.completeBusiness(tx, claim, "MEDIA_RECONCILE_COMPLETED");
          return { status: "completed", code: "ALREADY_PROMOTED" };
        }
        if (!grant.promotionDestinationKey || !grant.promotionSha256 || !grant.promotionCorrelationId) {
          return { status: "retryable", code: "PROMOTION_NOT_SETTLED", notBefore: effectiveWriteNotAfter(grant).toISOString() };
        }
        let immutable: Awaited<ReturnType<MediaStore["stat"]>>;
        try {
          immutable = await this.store.stat(grant.promotionDestinationKey, {
            signal: new AbortController().signal,
            deadline: new Date(this.clock.now().getTime() + 15_000),
            now: () => this.clock.now(),
          });
        } catch {
          if (this.clock.now().getTime() < effectiveWriteNotAfter(grant).getTime()) {
            return { status: "retryable", code: "PROMOTION_NOT_SETTLED", notBefore: effectiveWriteNotAfter(grant).toISOString() };
          }
          // At the proven settlement fence the staging key is no longer
          // writable.  Sweep it before closing the grant; a failed sweep
          // keeps the reconcile authority retryable instead of silently
          // dropping the only durable cleanup path.
          try {
            await this.store.deleteObjects([grant.objectKey], {
              signal: new AbortController().signal,
              deadline: new Date(this.clock.now().getTime() + 15_000),
              now: () => this.clock.now(),
            });
          } catch {
            return {
              status: "retryable",
              code: "PROMOTION_NOT_SETTLED",
              notBefore: new Date(this.clock.now().getTime() + 1_000).toISOString(),
            };
          }
          await tx.query(
            `UPDATE media_asset SET state = 'failed', failure_code = 'PROMOTION_ABANDONED', updated_at = transaction_timestamp()
             WHERE media_id = $1 AND room_id = $2`,
            [request.mediaId, request.roomId],
          );
          await tx.query(
            `UPDATE media_upload_grant SET state = 'closed', closed_at = transaction_timestamp()
             WHERE media_id = $1 AND room_id = $2`,
            [request.mediaId, request.roomId],
          );
          await this.claims.completeBusiness(tx, claim, "MEDIA_RECONCILE_COMPLETED");
          return { status: "completed", code: "PROMOTION_ABANDONED" };
        }
        if (immutable.sha256 !== grant.promotionSha256 || immutable.sizeBytes !== Number(media.size_bytes)) {
          await tx.query(
            `UPDATE media_asset SET state = 'failed', failure_code = 'PROMOTION_IDENTITY_MISMATCH', updated_at = transaction_timestamp()
             WHERE media_id = $1 AND room_id = $2`,
            [request.mediaId, request.roomId],
          );
          await this.claims.completeBusiness(tx, claim, "MEDIA_RECONCILE_COMPLETED");
          return { status: "completed", code: "PROMOTION_IDENTITY_MISMATCH" };
        }
        await tx.query(
          `UPDATE media_asset
           SET state = 'uploaded', object_key = $3, sha256 = $4,
               detected_mime = $5, promotion_correlation_id = $6,
               updated_at = transaction_timestamp()
           WHERE media_id = $1 AND room_id = $2`,
          [request.mediaId, request.roomId, grant.promotionDestinationKey, immutable.sha256, immutable.detectedMime, request.correlationId],
        );
        await tx.query(
          `UPDATE media_upload_grant SET state = 'promoted'
           WHERE media_id = $1 AND room_id = $2`,
          [request.mediaId, request.roomId],
        );
        await tx.query(
          `INSERT INTO worker_job(job_type, room_id, source_event_id, dedupe_key, correlation_id, payload, run_after)
           VALUES('media.process.v1',$1,NULL,$2,$3,$4,transaction_timestamp())
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [request.roomId, `media.process.v1:${request.mediaId}`, request.correlationId, { mediaId: request.mediaId }],
        );
        await this.claims.completeBusiness(tx, claim, "MEDIA_RECONCILE_COMPLETED");
        return { status: "completed", code: "PROMOTION_COMMITTED" };
      });
    } catch (error) {
      if ((error instanceof MediaError && error.code === "JOB_CLAIM_STALE")
        || (error instanceof Error && error.message === "JOB_CLAIM_STALE")) {
        return { status: "rejected", code: "JOB_CLAIM_STALE" };
      }
      throw error;
    }
  }
}
