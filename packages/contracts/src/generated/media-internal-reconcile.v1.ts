/* generated; source is JSON Schema */

/**
 * This interface was referenced by `MediaInternalReconcileContract`'s JSON-Schema
 * via the `definition` "Response".
 */
export type Response =
  | {
      status: "completed";
      code: "PROMOTION_COMMITTED" | "ALREADY_PROMOTED" | "PROMOTION_ABANDONED" | "PROMOTION_IDENTITY_MISMATCH";
    }
  | {
      status: "retryable";
      code: "PROMOTION_NOT_SETTLED";
      notBefore: string;
    }
  | {
      status: "rejected";
      code:
        "SERVICE_ASSERTION_INVALID" | "JOB_CLAIM_STALE" | "MEDIA_JOB_IDENTITY_MISMATCH" | "ROOM_DELETION_IN_PROGRESS";
    };

export interface MediaInternalReconcileContract {}
/**
 * This interface was referenced by `MediaInternalReconcileContract`'s JSON-Schema
 * via the `definition` "Request".
 */
export interface Request {
  jobId: string;
  jobType: "media.reconcile-upload.v1";
  roomId: string;
  sourceEventId: null;
  dedupeKey: string;
  mediaId: string;
  correlationId: string;
  claimGeneration: string;
  claimToken: string;
  workerId: string;
}
