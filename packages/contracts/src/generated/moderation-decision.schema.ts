/* generated; source is JSON Schema */

export interface ModerationDecision {
  decisionId: string;
  roomId: string;
  subjectKind: "agent_output" | "derived_artifact" | "media";
  subjectId: string;
  action: "allow" | "warn" | "hold" | "redact";
  policyVersion: string;
  /**
   * @maxItems 32
   */
  reasonCodes: string[];
  decidedBy: "deterministic_policy" | "approved_provider" | "teacher";
  createdAt: string;
}
