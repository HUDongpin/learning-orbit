/* generated; source is JSON Schema */

/**
 * This interface was referenced by `AgentProviderHealthContract`'s JSON-Schema
 * via the `definition` "Response".
 */
export type Response =
  | {
      status: "accepted" | "ignored_stale";
    }
  | {
      status: "rejected";
      code: "PROBE_ASSERTION_INVALID" | "PROVIDER_SCOPE_MISMATCH" | "HEALTH_SAMPLE_TIME_INVALID";
    };

export interface AgentProviderHealthContract {}
/**
 * This interface was referenced by `AgentProviderHealthContract`'s JSON-Schema
 * via the `definition` "Request".
 */
export interface Request {
  probeId: string;
  providerId: string;
  manifestSha256: string;
  health: "healthy" | "degraded" | "unavailable";
  checkedAt: string;
  reasonCode: string | null;
}
