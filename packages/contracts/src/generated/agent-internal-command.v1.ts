/* generated; source is JSON Schema */

/**
 * This interface was referenced by `AgentInternalCommandContract`'s JSON-Schema
 * via the `definition` "Response".
 */
export type Response =
  | {
      status: "applied" | "already_applied";
      eventId: string;
    }
  | {
      status: "rejected";
      code:
        | "SERVICE_ASSERTION_INVALID"
        | "JOB_CLAIM_STALE"
        | "AGENT_OUTPUT_INVALID"
        | "AGENT_RUN_NOT_ACTIVE"
        | "ROOM_NOT_OPEN";
    };

export interface AgentInternalCommandContract {}
/**
 * This interface was referenced by `AgentInternalCommandContract`'s JSON-Schema
 * via the `definition` "Request".
 */
export interface Request {
  jobId: string;
  jobType: "agent.execute.v1";
  roomId: string;
  sourceEventId: string;
  dedupeKey: string;
  agentRunId: string;
  correlationId: string;
  claimGeneration: string;
  claimToken: string;
  workerId: string;
  text: string;
  outputSha256: string;
  /**
   * @minItems 1
   * @maxItems 30
   */
  sourceEventIds: [string, ...string[]];
  /**
   * @maxItems 10
   */
  warningCodes:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string];
}
