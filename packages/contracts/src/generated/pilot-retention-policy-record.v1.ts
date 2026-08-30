/* generated; source is JSON Schema */

export interface PilotRetentionPolicyRecord {
  recordKind: "pilot_retention_policy";
  policyId: string;
  policyVersion: string;
  roomEventsDays: number;
  rawMediaDays: number;
  derivedArtifactsDays: number;
  projectionsDays: number;
  agentRunsDays: number;
  providerCopiesDays: number;
  backupsDays: number;
  auditMetadataDays: number;
  approvalReference: string;
  approvedAt: string;
  expiresAt: string;
}
