/* generated; source is JSON Schema */

export interface AgentCommandCatalog {}
/**
 * This interface was referenced by `AgentCommandCatalog`'s JSON-Schema
 * via the `definition` "RequestAgentRunInput".
 */
export interface RequestAgentRunInput {
  triggerEventId: string;
}
/**
 * This interface was referenced by `AgentCommandCatalog`'s JSON-Schema
 * via the `definition` "CancelAgentRunInput".
 */
export interface CancelAgentRunInput {}
/**
 * This interface was referenced by `AgentCommandCatalog`'s JSON-Schema
 * via the `definition` "AgentRunAccepted".
 */
export interface AgentRunAccepted {
  agentRunId: string;
  state: "queued" | "running" | "streaming" | "completed" | "blocked_by_policy" | "cancelled" | "failed";
}
/**
 * This interface was referenced by `AgentCommandCatalog`'s JSON-Schema
 * via the `definition` "CancelAgentRunAccepted".
 */
export interface CancelAgentRunAccepted {
  agentRunId: string;
  state: "cancelled";
}
/**
 * This interface was referenced by `AgentCommandCatalog`'s JSON-Schema
 * via the `definition` "AgentSettingsInput".
 */
export interface AgentSettingsInput {
  enabled: boolean;
}
/**
 * This interface was referenced by `AgentCommandCatalog`'s JSON-Schema
 * via the `definition` "AgentSettingsResponse".
 */
export interface AgentSettingsResponse {
  enabled: boolean;
  cancelledRunId: string | null;
}
