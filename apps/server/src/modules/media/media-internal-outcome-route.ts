import {
  mediaInternalOutcomeContract,
  realtimeContract,
  type MediaInternalOutcomeRequest,
  type MediaInternalOutcomeResponse,
  type RealtimeFrame,
} from "@learning-orbit/contracts";

import type { Clock } from "../../clock.js";
import { JobClaimAuthority, type JobClaimIdentity } from "../jobs/job-claim-authority.js";
import {
  authorizeServiceAssertion,
  verifyServiceAssertionEnvelope,
  type ServiceAssertionTrust,
} from "../security/service-assertion.js";
import type { RoomEventRepository } from "../rooms/room-event-repository.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** States a processing outcome may still be written onto. */
const ADMISSIBLE_MEDIA_STATES = new Set(["uploaded", "processing"]);

export interface MediaStatusBroadcaster {
  broadcastAuthorized(roomId: string, frame: RealtimeFrame): Promise<number>;
}

/**
 * The return leg of media processing.
 *
 * Scanning, sanitising and transcoding all happen in the Python worker; this is
 * the only path by which their result becomes server state. Without it an
 * upload that processed perfectly stays in `processing` forever, because
 * nothing else may write the terminal state or register a derivative.
 *
 * The status frame is emitted only after commit, and is deliberately not a
 * RoomEvent: it allocates no roomSeq and writes neither room_event nor
 * outbox_event. Losing the broadcast therefore loses no authority - a
 * reconnecting client reads the same state through routes.media.get.
 */
export class MediaInternalOutcomeRoute {
  constructor(
    private readonly events: RoomEventRepository,
    private readonly clock: Clock,
    private readonly trust: ServiceAssertionTrust,
    private readonly claims: JobClaimAuthority = new JobClaimAuthority(),
    private readonly realtime?: MediaStatusBroadcaster,
  ) {}

  async handle(rawAssertion: unknown, value: unknown): Promise<MediaInternalOutcomeResponse> {
    // Assertion before parse: an unsigned caller never reaches the generated
    // validator, so schema behaviour cannot be probed without a trusted key.
    let signedBy: string;
    try {
      signedBy = verifyServiceAssertionEnvelope(rawAssertion, value, {
        audience: "internal.media.outcome",
      }, this.trust, this.clock.now());
    } catch {
      return { status: "rejected", code: "SERVICE_ASSERTION_INVALID" };
    }
    let request: MediaInternalOutcomeRequest;
    try {
      request = mediaInternalOutcomeContract.parseRequest(value);
    } catch {
      return { status: "rejected", code: "MEDIA_OUTCOME_INVALID" };
    }
    const claim: JobClaimIdentity = request;
    try {
      if (request.workerId !== signedBy) throw new Error("SERVICE_ASSERTION_INVALID");
      authorizeServiceAssertion(rawAssertion, request, {
        audience: "internal.media.outcome",
        workerId: request.workerId,
        claim,
      }, this.trust, this.clock.now());
    } catch {
      return { status: "rejected", code: "SERVICE_ASSERTION_INVALID" };
    }
    // A terminal failure carries its code; a success never does. Neither the
    // schema nor the database can express that pairing, so it is checked here.
    const terminalFailure = request.state === "quarantined" || request.state === "failed";
    if (terminalFailure !== (request.failureCode !== null)) {
      return { status: "rejected", code: "MEDIA_OUTCOME_INVALID" };
    }
    if (request.state !== "ready" && request.derivatives.length > 0) {
      return { status: "rejected", code: "MEDIA_OUTCOME_INVALID" };
    }
    if (new Set(request.derivatives.map(({ kind }) => kind)).size !== request.derivatives.length) {
      return { status: "rejected", code: "MEDIA_OUTCOME_INVALID" };
    }

    let broadcast: { state: string; failureCode: string | null; updatedAt: string } | undefined;
    let outcome: MediaInternalOutcomeResponse;
    try {
      outcome = await this.events.transact(request.roomId, async (context) => {
        const tx = context.client;
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
          && job.room_id === request.roomId
          && job.source_event_id === null
          && job.dedupe_key === request.dedupeKey
          && job.correlation_id === request.correlationId
          && !!payload
          && payload.mediaId === request.mediaId;
        if (!identityOk) return { status: "rejected", code: "MEDIA_OUTCOME_INVALID" };

        try {
          await this.claims.requireCurrent(tx, claim);
        } catch {
          return { status: "rejected", code: "JOB_CLAIM_STALE" };
        }

        const mediaResult = await tx.query<{
          state: string;
          failure_code: string | null;
          outcome_transition_id: string | null;
          updated_at: Date;
        }>(
          `SELECT state, failure_code, outcome_transition_id, updated_at
           FROM media_asset WHERE media_id = $1 AND room_id = $2 FOR UPDATE`,
          [request.mediaId, request.roomId],
        );
        const media = mediaResult.rows[0];
        if (!media) return { status: "rejected", code: "MEDIA_OUTCOME_INVALID" };

        // The transition UUID is the idempotency key. A retry of the same
        // transition is a no-op that reports success; a different transition
        // arriving after one has committed is a stale attempt, not a second
        // legitimate outcome.
        if (media.outcome_transition_id !== null) {
          if (media.outcome_transition_id !== request.transitionId) {
            return { status: "rejected", code: "MEDIA_OUTCOME_INVALID" };
          }
          await this.claims.completeBusiness(tx, claim, "MEDIA_PROCESS_COMPLETED");
          return { status: "already_applied" };
        }
        if (!ADMISSIBLE_MEDIA_STATES.has(media.state)) {
          return { status: "rejected", code: "MEDIA_OUTCOME_INVALID" };
        }

        for (const derivative of request.derivatives) {
          await tx.query(
            `INSERT INTO media_derivative(derivative_id, media_id, kind, object_key, mime, size_bytes, sha256)
             VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [derivative.derivativeId, request.mediaId, derivative.kind,
              derivative.objectKey, derivative.mime, derivative.sizeBytes, derivative.sha256],
          );
        }

        const updated = await tx.query<{ updated_at: Date }>(
          `UPDATE media_asset
           SET state = $3::media_state, failure_code = $4,
               outcome_transition_id = $5, updated_at = transaction_timestamp()
           WHERE media_id = $1 AND room_id = $2
           RETURNING updated_at`,
          [request.mediaId, request.roomId, request.state, request.failureCode, request.transitionId],
        );

        // A non-terminal `processing` acknowledgement leaves the job running
        // for the worker; only a terminal state closes the business claim.
        if (request.state !== "processing") {
          await this.claims.completeBusiness(tx, claim, "MEDIA_PROCESS_COMPLETED");
        }
        broadcast = {
          state: request.state,
          failureCode: request.failureCode,
          updatedAt: updated.rows[0]!.updated_at.toISOString(),
        };
        return { status: "applied" };
      });
    } catch (error) {
      if (error instanceof Error && error.message === "JOB_CLAIM_STALE") {
        return { status: "rejected", code: "JOB_CLAIM_STALE" };
      }
      throw error;
    }

    if (broadcast && this.realtime) {
      try {
        await this.realtime.broadcastAuthorized(request.roomId, realtimeContract.parseRealtimeFrame({
          type: "media_status",
          mediaId: request.mediaId,
          state: broadcast.state,
          failureCode: broadcast.failureCode,
          updatedAt: broadcast.updatedAt,
        }));
      } catch {
        // The durable outcome has already committed. A lost frame costs a
        // client one refresh; it must never turn a committed transition into
        // a retryable one.
      }
    }
    return outcome;
  }
}
