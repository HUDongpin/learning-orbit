/* generated; source is JSON Schema */

/**
 * This interface was referenced by `LifecycleInternalMediaSurfaceContract`'s JSON-Schema
 * via the `definition` "Response".
 */
export type Response =
  | {
      status: "completed" | "already_verified";
      surface: "media";
      verifiedItemCount: number;
    }
  | {
      status: "retryable";
      code: "MEDIA_SURFACE_NOT_QUIESCENT" | "MEDIA_SURFACE_STORE_UNAVAILABLE";
      notBefore: string;
    }
  | {
      status: "rejected";
      code: "SERVICE_ASSERTION_INVALID" | "JOB_CLAIM_STALE" | "LIFECYCLE_SURFACE_IDENTITY_INVALID";
    };

export interface LifecycleInternalMediaSurfaceContract {}
/**
 * This interface was referenced by `LifecycleInternalMediaSurfaceContract`'s JSON-Schema
 * via the `definition` "Request".
 */
export interface Request {
  jobId: string;
  jobType: "room.delete-surface.v1";
  roomId: null;
  sourceEventId: null;
  dedupeKey: string;
  deletionJobId: string;
  surface: "media";
  correlationId: string;
  claimGeneration: string;
  claimToken: string;
  workerId: string;
}
