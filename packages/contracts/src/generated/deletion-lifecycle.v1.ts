/* generated; source is JSON Schema */

/**
 * This interface was referenced by `DeletionLifecycle`'s JSON-Schema
 * via the `definition` "DeletionStatus".
 */
export type DeletionStatus =
  | {
      deletionJobId: string;
      status: "queued" | "running" | "retryable" | "dead";
      nextPollAfterMs: number | null;
      failureCode: string | null;
    }
  | {
      deletionJobId: string;
      status: "completed";
      receipt: DeletionReceipt;
    };

export interface DeletionLifecycle {}
/**
 * This interface was referenced by `DeletionLifecycle`'s JSON-Schema
 * via the `definition` "DeleteRoomRequest".
 */
export interface DeleteRoomRequest {
  confirmation: string;
}
/**
 * This interface was referenced by `DeletionLifecycle`'s JSON-Schema
 * via the `definition` "DeleteRoomAccepted".
 */
export interface DeleteRoomAccepted {
  deletionJobId: string;
  status: "queued";
}
/**
 * This interface was referenced by `DeletionLifecycle`'s JSON-Schema
 * via the `definition` "DeletionReceipt".
 */
export interface DeletionReceipt {
  receiptVersion: 1;
  /**
   * @minItems 8
   */
  surfacesVerified: [
    "agent_runs" | "artifacts" | "caches" | "derivatives" | "events" | "media" | "projections" | "provider_copies",
    "agent_runs" | "artifacts" | "caches" | "derivatives" | "events" | "media" | "projections" | "provider_copies",
    "agent_runs" | "artifacts" | "caches" | "derivatives" | "events" | "media" | "projections" | "provider_copies",
    "agent_runs" | "artifacts" | "caches" | "derivatives" | "events" | "media" | "projections" | "provider_copies",
    "agent_runs" | "artifacts" | "caches" | "derivatives" | "events" | "media" | "projections" | "provider_copies",
    "agent_runs" | "artifacts" | "caches" | "derivatives" | "events" | "media" | "projections" | "provider_copies",
    "agent_runs" | "artifacts" | "caches" | "derivatives" | "events" | "media" | "projections" | "provider_copies",
    "agent_runs" | "artifacts" | "caches" | "derivatives" | "events" | "media" | "projections" | "provider_copies",
    ...(
      "agent_runs" | "artifacts" | "caches" | "derivatives" | "events" | "media" | "projections" | "provider_copies"
    )[]
  ];
  completedAt: string;
}
