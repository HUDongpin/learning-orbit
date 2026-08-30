/* generated; source is JSON Schema */

export interface AgentRun {
  agentRunId: string;
  roomId: string;
  state: "queued" | "running" | "streaming" | "completed" | "blocked_by_policy" | "cancelled" | "failed";
  triggerEventId: string;
  requestedByActorId: string;
  requestedByRole: "student" | "teacher";
  inputFromRoomSeq: number;
  inputThroughRoomSeq: number;
  modelProvider: string;
  modelId: string;
  promptVersion: string;
  policyVersion: string;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}
