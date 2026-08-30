/* generated; source is JSON Schema */

export interface AgentCurrentState {
  roomId: string;
  run: null | {
    agentRunId: string;
    state: "queued" | "running" | "streaming" | "completed" | "blocked_by_policy" | "cancelled" | "failed";
    failureCode: string | null;
    createdAt: string;
    updatedAt: string;
  };
  serviceHealth: "healthy" | "degraded" | "unavailable";
  agentEnabled: boolean;
  updatedAt: string;
}
