/* generated; source is JSON Schema */

/**
 * This interface was referenced by `MediaInternalOutcomeContract`'s JSON-Schema
 * via the `definition` "Response".
 */
export type Response =
  | {
      status: "applied" | "already_applied";
    }
  | {
      status: "rejected";
      code: "SERVICE_ASSERTION_INVALID" | "JOB_CLAIM_STALE" | "MEDIA_OUTCOME_INVALID" | "ROOM_DELETION_IN_PROGRESS";
    };

export interface MediaInternalOutcomeContract {}
/**
 * This interface was referenced by `MediaInternalOutcomeContract`'s JSON-Schema
 * via the `definition` "Derivative".
 */
export interface Derivative {
  derivativeId: string;
  kind: "thumbnail" | "sanitized_image" | "playback_audio" | "waveform";
  objectKey: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
}
/**
 * This interface was referenced by `MediaInternalOutcomeContract`'s JSON-Schema
 * via the `definition` "Request".
 */
export interface Request {
  jobId: string;
  jobType: "media.process.v1";
  roomId: string;
  sourceEventId: null;
  dedupeKey: string;
  mediaId: string;
  transitionId: string;
  state: "processing" | "ready" | "quarantined" | "failed";
  failureCode: string | null;
  /**
   * @maxItems 4
   */
  derivatives:
    | []
    | [Derivative]
    | [Derivative, Derivative]
    | [Derivative, Derivative, Derivative]
    | [Derivative, Derivative, Derivative, Derivative];
  correlationId: string;
  claimGeneration: string;
  claimToken: string;
  workerId: string;
}
