export interface RetentionPolicy {
  readonly roomEventsDays: number;
  readonly rawMediaDays: number;
  readonly derivedArtifactsDays: number;
  readonly projectionsDays: number;
  readonly agentRunsDays: number;
  readonly providerCopiesDays: number;
  readonly backupsDays: number;
  readonly auditMetadataDays: number;
}

export function assertPilotRetentionPolicy(policy: RetentionPolicy): void {
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`INVALID_RETENTION_${key.toUpperCase()}`);
  }
  if (policy.roomEventsDays < Math.max(policy.derivedArtifactsDays, policy.projectionsDays, policy.agentRunsDays)) {
    throw new Error("RETENTION_PARENT_EXPIRES_BEFORE_DEPENDENT");
  }
  if (policy.rawMediaDays < policy.derivedArtifactsDays) {
    throw new Error("RETENTION_MEDIA_EXPIRES_BEFORE_DERIVATIVE");
  }
  if (policy.providerCopiesDays > Math.min(policy.rawMediaDays, policy.derivedArtifactsDays, policy.agentRunsDays)) {
    throw new Error("RETENTION_PROVIDER_COPY_OUTLIVES_SOURCE");
  }
}

const ONLINE_SURFACES = ["agent_runs", "artifacts", "caches", "derivatives", "events", "media", "projections", "provider_copies"] as const;
export type DeletionSurface = typeof ONLINE_SURFACES[number];

export function makeDeletionReceipt(job: { completedAt: string; surfacesVerified: readonly string[] }) {
  const actual = [...new Set(job.surfacesVerified)].sort();
  if (actual.length !== ONLINE_SURFACES.length || actual.join(",") !== [...ONLINE_SURFACES].sort().join(",")) {
    throw new Error("DELETION_SURFACES_INCOMPLETE");
  }
  return { receiptVersion: 1 as const, completedAt: job.completedAt, surfacesVerified: actual as DeletionSurface[] };
}

