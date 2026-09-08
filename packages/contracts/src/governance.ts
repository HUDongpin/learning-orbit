import type { ValidateFunction } from "ajv";
import retentionSchema from "../schemas/pilot-retention-policy-record.v1.json" with { type: "json" };
import authoritySchema from "../schemas/provider-copy-authority-record.v1.json" with { type: "json" };
import deletionSchema from "../schemas/deletion-lifecycle.v1.json" with { type: "json" };
import shadowSchema from "../schemas/human-shadow-record.v1.json" with { type: "json" };
import externalAuthorizationSchema from "../schemas/external-authorization-record.v1.json" with { type: "json" };
import promotionSchema from "../schemas/student-visible-promotion-record.v1.json" with { type: "json" };
import type { PilotRetentionPolicyRecord } from "./generated/pilot-retention-policy-record.v1.js";
import type { ProviderCopyAuthorityRecord } from "./generated/provider-copy-authority-record.v1.js";
import type { HumanShadowRecord } from "./generated/human-shadow-record.v1.js";
import type { ExternalAuthorizationRecord } from "./generated/external-authorization-record.v1.js";
import type { StudentVisiblePromotionRecord } from "./generated/student-visible-promotion-record.v1.js";
import type {
  DeleteRoomRequest, DeleteRoomAccepted, DeletionStatus, DeletionReceipt,
} from "./generated/deletion-lifecycle.v1.js";
import { makeSchemaAjv } from "./schema-ajv.js";

const ajv = makeSchemaAjv();
for (const schema of [
  retentionSchema, authoritySchema, deletionSchema, shadowSchema,
  externalAuthorizationSchema, promotionSchema,
]) ajv.addSchema(schema);
function validator<T>(id: string): ValidateFunction<T> {
  const value = ajv.getSchema(id);
  if (!value) throw new Error("GOVERNANCE_SCHEMA_REGISTRATION_FAILED");
  return value as ValidateFunction<T>;
}
function parse<T>(value: unknown, check: ValidateFunction<T>, code: string): T {
  if (!check(value)) throw new Error(code);
  return value;
}
/**
 * Read a timestamp that has to land on a real instant to be compared at all.
 *
 * `format: "date-time"` admits strings `Date.parse` cannot place - a leap
 * second such as `2026-12-31T23:59:60Z` parses to NaN, and every comparison
 * against NaN is false, so an ordering refusal written `a > b` would wave the
 * record through instead of refusing it. Refusing here means each ordering
 * check downstream compares two instants or never runs. Mirrors the
 * convention in the server's controlled-authority verifier.
 */
function time(value: string, code: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
}
const retention = validator<PilotRetentionPolicyRecord>(retentionSchema.$id);
const authority = validator<ProviderCopyAuthorityRecord>(authoritySchema.$id);
const shadow = validator<HumanShadowRecord>(shadowSchema.$id);
const externalAuthorization = validator<ExternalAuthorizationRecord>(externalAuthorizationSchema.$id);
const promotion = validator<StudentVisiblePromotionRecord>(promotionSchema.$id);
const deleteRequest = validator<DeleteRoomRequest>(`${deletionSchema.$id}#/$defs/DeleteRoomRequest`);
const accepted = validator<DeleteRoomAccepted>(`${deletionSchema.$id}#/$defs/DeleteRoomAccepted`);
const status = validator<DeletionStatus>(`${deletionSchema.$id}#/$defs/DeletionStatus`);
const receipt = validator<DeletionReceipt>(`${deletionSchema.$id}#/$defs/DeletionReceipt`);

export const pilotRetentionPolicyContract = {
  parse(value: unknown): PilotRetentionPolicyRecord {
    const result = parse(value, retention, "INVALID_PILOT_RETENTION_POLICY");
    const r = result as PilotRetentionPolicyRecord;
    const approved = time(r.approvedAt, "INVALID_PILOT_RETENTION_POLICY");
    const expires = time(r.expiresAt, "INVALID_PILOT_RETENTION_POLICY");
    if (!(expires > approved)) throw new Error("INVALID_PILOT_RETENTION_POLICY");
    if (r.roomEventsDays < Math.max(r.derivedArtifactsDays, r.projectionsDays, r.agentRunsDays)
      || r.rawMediaDays < r.derivedArtifactsDays
      || r.providerCopiesDays > Math.min(r.rawMediaDays, r.derivedArtifactsDays, r.agentRunsDays)) {
      throw new Error("INVALID_PILOT_RETENTION_POLICY");
    }
    return result;
  },
  encode(value: unknown): string { return JSON.stringify(this.parse(value)); },
};

/** One version each, in front of the body, before it decided. */
const REVIEWED_DOCUMENT_KINDS = ["threat_model", "data_inventory", "retention_policy"] as const;
/** Beyond a school term an authorisation is a standing permission, not a pilot. */
const MAX_AUTHORIZED_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * The school and research-ethics authorization.
 *
 * Engineering supplies this format and this checker; it cannot supply the
 * decision, and no amount of well-formedness turns a document into one. What
 * the checker can do is refuse a document that authorises more than it
 * accounts for: a body that is - or whose named signer is - a party running
 * the pilot, a window that opened before the decision was taken, a cap that
 * never binds, a provider scope carrying the other mode's fields, a date that
 * never happened. Widening any of these is a new signed decision, because
 * there is nothing here to read more broadly.
 */
export const externalAuthorizationRecordContract = {
  parse(value: unknown): ExternalAuthorizationRecord {
    const result = parse(value, externalAuthorization, "INVALID_EXTERNAL_AUTHORIZATION_RECORD");
    if (result.synthetic) throw new Error("AUTHORIZATION_WAS_SYNTHETIC");
    if (result.usedForGradesOrDiscipline) throw new Error("AUTHORIZATION_USED_FOR_GRADES_OR_DISCIPLINE");
    const invalid = "INVALID_EXTERNAL_AUTHORIZATION_RECORD";
    const decided = time(result.authorizingBody.decidedAt, invalid);
    const from = time(result.scope.sessionsFrom, invalid);
    const until = time(result.scope.sessionsUntil, invalid);
    // Read every reviewed date before the ordering check below, so an
    // unplaceable one is refused as malformed rather than skipped by a
    // short-circuit on the session window.
    const reviewedAt = result.reviewedDocuments.map((entry) => time(entry.reviewedAt, invalid));
    const consentObtainedBy = time(result.participantInformation.consentObtainedBy, invalid);
    if (!(until > from)) throw new Error(invalid);
    // An approval signed by the party that runs the pilot is that party's own
    // opinion of itself, whatever the letterhead says - and a body whose only
    // named signer is that party is the same document with a longer chain.
    const operating = new Set<string>([
      result.supervisingTeacherRef, result.rollbackOwnerRef, ...result.incidentContactRefs,
    ]);
    if (operating.has(result.authorizingBody.bodyRef)
      || result.authorizedSignerRefs.some((ref) => operating.has(ref))) {
      throw new Error("AUTHORIZATION_SELF_ISSUED");
    }
    // Reviewed, then decided, then run. A session covered before the decision,
    // or a document read after it, is not the thing the body approved.
    if (from < decided || reviewedAt.some((at) => at > decided)) {
      throw new Error("AUTHORIZATION_DECISION_OUT_OF_ORDER");
    }
    const reviewed = new Set(result.reviewedDocuments.map((entry) => entry.documentKind));
    if (reviewed.size !== result.reviewedDocuments.length
      || REVIEWED_DOCUMENT_KINDS.some((kind) => !reviewed.has(kind))) {
      throw new Error("AUTHORIZATION_REVIEWED_DOCUMENTS_INCOMPLETE");
    }
    if (until - from > MAX_AUTHORIZED_WINDOW_MS
      || result.scope.maxStudentsPerRoom > result.scope.maxStudentsTotal) {
      throw new Error("AUTHORIZATION_SCOPE_UNBOUNDED");
    }
    if (consentObtainedBy > from) {
      throw new Error("AUTHORIZATION_CONSENT_NOT_OBTAINED_BEFORE_SESSIONS");
    }
    const provider = result.providerScope;
    const namesPortVersions = provider.capabilitySchemaVersion !== undefined
      || provider.portSchemaVersion !== undefined;
    const namesCopyAuthority = provider.copyAuthorityRecordSha256 !== undefined
      || provider.copyAuthorityExpiresAt !== undefined;
    if (provider.remoteCopyMode === "no_persistent_copy_attested") {
      // An attestation that lapses before the last authorised session leaves
      // those sessions running under nothing at all.
      if (provider.copyAuthorityRecordSha256 === undefined
        || provider.copyAuthorityExpiresAt === undefined
        || namesPortVersions) {
        throw new Error("AUTHORIZATION_PROVIDER_SCOPE_MISMATCH");
      }
      if (time(provider.copyAuthorityExpiresAt, invalid) < until) {
        throw new Error("AUTHORIZATION_PROVIDER_SCOPE_MISMATCH");
      }
    } else if (provider.capabilitySchemaVersion === undefined
      || provider.portSchemaVersion === undefined
      || namesCopyAuthority) {
      throw new Error("AUTHORIZATION_PROVIDER_SCOPE_MISMATCH");
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
    const started = time(result.startedAt, "INVALID_HUMAN_SHADOW_RECORD");
    const ended = time(result.endedAt, "INVALID_HUMAN_SHADOW_RECORD");
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

/**
 * The decision to show students the analytics built from their own conversation.
 *
 * Signed separately from the shadow by design, and checked that way here: a
 * record that says it was derived from the shadow, or that was signed by the
 * teacher who ran it, is refused however coherent the rest of it reads. The
 * keys are named out loud because default deny is the resting state - an empty
 * list is a decision to stay there, an absent list is not a decision at all.
 */
export const studentVisiblePromotionRecordContract = {
  parse(value: unknown): StudentVisiblePromotionRecord {
    const result = parse(value, promotion, "INVALID_STUDENT_VISIBLE_PROMOTION_RECORD");
    if (result.synthetic) throw new Error("PROMOTION_WAS_SYNTHETIC");
    if (result.usedForGradesOrDiscipline) throw new Error("PROMOTION_USED_FOR_GRADES_OR_DISCIPLINE");
    if (result.derivedFromShadowRecord) throw new Error("PROMOTION_INFERRED_FROM_SHADOW");
    if (result.decidedBy.deciderRef === result.shadowTeacherRef) {
      throw new Error("PROMOTION_DECIDED_BY_SHADOW_TEACHER");
    }
    const invalid = "INVALID_STUDENT_VISIBLE_PROMOTION_RECORD";
    const decided = time(result.decidedBy.decidedAt, invalid);
    const starts = time(result.startsAt, invalid);
    const expires = time(result.expiresAt, invalid);
    const authorizedFrom = time(result.authorizedFrom, invalid);
    const authorizedUntil = time(result.authorizedUntil, invalid);
    if (!(expires > starts) || !(authorizedUntil > authorizedFrom)) throw new Error(invalid);
    if (decided > starts) throw new Error("PROMOTION_DECISION_OUT_OF_ORDER");
    // Visibility cannot begin before, or outlast, the authorization it rests
    // on. The importer still compares this restatement against the verified
    // authorization record; a restatement is not the record.
    if (starts < authorizedFrom || expires > authorizedUntil) {
      throw new Error("PROMOTION_SCOPE_EXCEEDS_AUTHORIZATION");
    }
    if (result.shadowVerdict === "not_ready" && result.studentProjectionKeys.length > 0) {
      throw new Error("PROMOTION_CONTRADICTS_SHADOW_VERDICT");
    }
    // A withdrawal slower than the grant it withdraws is a promise, not a path.
    if (result.revocation.maxLatencyMinutes * 60_000 > expires - starts) {
      throw new Error("PROMOTION_REVOCATION_PATH_INEFFECTIVE");
    }
    return result;
  },
  encode(value: unknown): string { return JSON.stringify(this.parse(value)); },
};

export const providerCopyAuthorityContract = {
  parse(value: unknown): ProviderCopyAuthorityRecord {
    const result = parse(value, authority, "INVALID_PROVIDER_COPY_AUTHORITY");
    const starts = time(result.startsAt, "INVALID_PROVIDER_COPY_AUTHORITY");
    const expires = time(result.expiresAt, "INVALID_PROVIDER_COPY_AUTHORITY");
    if (!(expires > starts)) throw new Error("INVALID_PROVIDER_COPY_AUTHORITY");
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
export type { ExternalAuthorizationRecord } from "./generated/external-authorization-record.v1.js";
export type { StudentVisiblePromotionRecord } from "./generated/student-visible-promotion-record.v1.js";
export type { DeleteRoomRequest, DeleteRoomAccepted, DeletionStatus, DeletionReceipt } from "./generated/deletion-lifecycle.v1.js";
