/* generated; source is JSON Schema */

/**
 * This interface was referenced by `RoomInternalAutoCloseContract`'s JSON-Schema
 * via the `definition` "Response".
 */
export type Response =
  | {
      status: "completed";
      code: "ROOM_CLOSED" | "ALREADY_CLOSED";
    }
  | {
      status: "retryable";
      code: "ROOM_CLOSE_NOT_DUE";
    }
  | {
      status: "rejected";
      code:
        "SERVICE_ASSERTION_INVALID" | "JOB_CLAIM_STALE" | "JOB_FAMILY_IDENTITY_INVALID" | "ROOM_DELETION_IN_PROGRESS";
    };

export interface RoomInternalAutoCloseContract {}
/**
 * This interface was referenced by `RoomInternalAutoCloseContract`'s JSON-Schema
 * via the `definition` "Request".
 */
export interface Request {
  jobId: string;
  jobType: "room.auto-close.v1";
  roomId: string;
  sourceEventId: string;
  dedupeKey: string;
  correlationId: string;
  claimGeneration: string;
  claimToken: string;
  workerId: string;
  closesAt: string;
}
