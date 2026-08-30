/* generated; source is JSON Schema */

export interface AgentStatusFrame {
  type: "agent_status";
  roomId: string;
  agentRunId: string | null;
  state: "idle" | "queued" | "running" | "streaming" | "completed" | "blocked_by_policy" | "cancelled" | "failed";
  serviceHealth: "healthy" | "degraded" | "unavailable";
  agentEnabled: boolean;
  updatedAt: string;
  failureCode: string | null;
}
