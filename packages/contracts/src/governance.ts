import type { ValidateFunction } from "ajv";
import retentionSchema from "../schemas/pilot-retention-policy-record.v1.json" with { type: "json" };
import authoritySchema from "../schemas/provider-copy-authority-record.v1.json" with { type: "json" };
import deletionSchema from "../schemas/deletion-lifecycle.v1.json" with { type: "json" };
import shadowSchema from "../schemas/human-shadow-record.v1.json" with { type: "json" };
import type { PilotRetentionPolicyRecord } from "./generated/pilot-retention-policy-record.v1.js";
import type { ProviderCopyAuthorityRecord } from "./generated/provider-copy-authority-record.v1.js";
import type { HumanShadowRecord } from "./generated/human-shadow-record.v1.js";
import type {
  DeleteRoomRequest, DeleteRoomAccepted, DeletionStatus, DeletionReceipt,
} from "./generated/deletion-lifecycle.v1.js";
import { makeSchemaAjv } from "./schema-ajv.js";

const ajv = makeSchemaAjv();
for (const schema of [retentionSchema, authoritySchema, deletionSchema, shadowSchema]) ajv.addSchema(schema);
function validator<T>(id: string): ValidateFunction<T> {
  const value = ajv.getSchema(id);
  if (!value) throw new Error("GOVERNANCE_SCHEMA_REGISTRATION_FAILED");
  return value as ValidateFunction<T>;
}
function parse<T>(value: unknown, check: ValidateFunction<T>, code: string): T {
  if (!check(value)) throw new Error(code);
  return value;
}
const retention = validator<PilotRetentionPolicyRecord>(retentionSchema.$id);
const authority = validator<ProviderCopyAuthorityRecord>(authoritySchema.$id);
const shadow = validator<HumanShadowRecord>(shadowSchema.$id);
const deleteRequest = validator<DeleteRoomRequest>(`${deletionSchema.$id}#/$defs/DeleteRoomRequest`);
const accepted = validator<DeleteRoomAccepted>(`${deletionSchema.$id}#/$defs/DeleteRoomAccepted`);
const status = validator<DeletionStatus>(`${deletionSchema.$id}#/$defs/DeletionStatus`);
const receipt = validator<DeletionReceipt>(`${deletionSchema.$id}#/$defs/DeletionReceipt`);

export const pilotRetentionPolicyContract = {
  parse(value: unknown): PilotRetentionPolicyRecord {
    const result = parse(value, retention, "INVALID_PILOT_RETENTION_POLICY");
    const r = result as PilotRetentionPolicyRecord;
    if (new Date(r.expiresAt).getTime() <= new Date(r.approvedAt).getTime()) throw new Error("INVALID_PILOT_RETENTION_POLICY");
    if (r.roomEventsDays < Math.max(r.derivedArtifactsDays, r.projectionsDays, r.agentRunsDays)
      || r.rawMediaDays < r.derivedArtifactsDays
      || r.providerCopiesDays > Math.min(r.rawMediaDays, r.derivedArtifactsDays, r.agentRunsDays)) {
      throw new Error("INVALID_PILOT_RETENTION_POLICY");
    }
    return result;
  },
  encode(value: unknown): string { return JSON.stringify(this.parse(value)); },
};

/**
 * The completed teacher shadow.
 *
 * Engineering supplies this format and this checker; it cannot supply the
 * record. What the checker can do is refuse a document that is internally
 * inconsistent, or that says in its own fields that it was not a shadow — a
 * synthetic rehearsal is useful preparation and is not the thing Gate 6 asks
 * for, and a session with students in it is not a shadow at all.
 */
export const humanShadowRecordContract = {
  parse(value: unknown): HumanShadowRecord {
    const result = parse(value, shadow, "INVALID_HUMAN_SHADOW_RECORD");
    if (result.rehearsal) throw new Error("SHADOW_WAS_A_REHEARSAL");
    if (result.studentsPresent) throw new Error("SHADOW_HAD_STUDENTS_PRESENT");
    const started = new Date(result.startedAt).getTime();
    const ended = new Date(result.endedAt).getTime();
    if (!(ended > started)) throw new Error("INVALID_HUMAN_SHADOW_RECORD");
    // A shadow long enough to see the agent behave is the point; a record
    // spanning a minute describes something else.
    if (ended - started < 10 * 60 * 1000) throw new Error("SHADOW_TOO_SHORT");
    const observed = new Set(result.observations.map((entry) => entry.agentRunId));
    const declared = new Set(result.agentRunsObserved);
    if (observed.size !== declared.size || [...declared].some((id) => !observed.has(id))) {
      // A verdict not grounded in an observation of every run it claims to
      // cover is an opinion wearing the shape of evidence.
      throw new Error("SHADOW_OBSERVATIONS_INCOMPLETE");
    }
    if (result.verdict === "ready_for_students"
      && result.observations.some((entry) => entry.outcome === "harmful")) {
      throw new Error("SHADOW_VERDICT_CONTRADICTS_OBSERVATIONS");
    }
    return result;
  },
  encode(value: unknown): string { return JSON.stringify(this.parse(value)); },
};

export const providerCopyAuthorityContract = {
  parse(value: unknown): ProviderCopyAuthorityRecord {
    const result = parse(value, authority, "INVALID_PROVIDER_COPY_AUTHORITY");
    if (new Date(result.expiresAt).getTime() <= new Date(result.startsAt).getTime()) throw new Error("INVALID_PROVIDER_COPY_AUTHORITY");
    return result;
  },
  encode(value: unknown): string { return JSON.stringify(this.parse(value)); },
};

const allSurfaces = ["agent_runs", "artifacts", "caches", "derivatives", "events", "media", "projections", "provider_copies"] as const;
export function parseDeletionReceipt(value: unknown): DeletionReceipt {
  const result = parse(value, receipt, "INVALID_DELETION_RECEIPT");
  if (result.surfacesVerified.length !== allSurfaces.length
    || [...result.surfacesVerified].sort().join(",") !== [...allSurfaces].sort().join(",")) throw new Error("INVALID_DELETION_RECEIPT");
  return result;
}
export const deletionLifecycleContract = {
  parseRequest(value: unknown): DeleteRoomRequest { return parse(value, deleteRequest, "INVALID_DELETE_REQUEST"); },
  parseAccepted(value: unknown): DeleteRoomAccepted { return parse(value, accepted, "INVALID_DELETION_ACCEPTED"); },
  parseReceipt: parseDeletionReceipt,
  parseStatus(value: unknown): DeletionStatus {
    const result = parse(value, status, "INVALID_DELETION_STATUS");
    if (result.status === "completed") parseDeletionReceipt(result.receipt);
    return result;
  },
  encodeRequest(value: unknown): string { return JSON.stringify(this.parseRequest(value)); },
  encodeAccepted(value: unknown): string { return JSON.stringify(this.parseAccepted(value)); },
  encodeStatus(value: unknown): string { return JSON.stringify(this.parseStatus(value)); },
};

export type { PilotRetentionPolicyRecord } from "./generated/pilot-retention-policy-record.v1.js";
export type { ProviderCopyAuthorityRecord } from "./generated/provider-copy-authority-record.v1.js";
export type { HumanShadowRecord } from "./generated/human-shadow-record.v1.js";
export type { DeleteRoomRequest, DeleteRoomAccepted, DeletionStatus, DeletionReceipt } from "./generated/deletion-lifecycle.v1.js";
