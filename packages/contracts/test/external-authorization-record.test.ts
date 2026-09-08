import { describe, expect, it } from "vitest";

import { externalAuthorizationRecordContract } from "../src/governance.js";

const BODY = "b".repeat(64);
const SCHOOL = "5".repeat(64);
const CLASSROOM = "c".repeat(64);
const TEACHER = "7".repeat(64);
const ROLLBACK = "d".repeat(64);
const CONTACT = "e".repeat(64);
const SIGNER = "f".repeat(64);
const SHEET = "1".repeat(64);
const THREAT_MODEL = "2".repeat(64);
const DATA_INVENTORY = "3".repeat(64);
const RETENTION_POLICY = "4".repeat(64);
const PROVIDER_MANIFEST = "6".repeat(64);
const COPY_AUTHORITY = "8".repeat(64);
const ROOM = "11111111-1111-4111-8111-111111111111";
/** Well-formed to `format: "date-time"`, unplaceable to `Date.parse`. */
const LEAP_SECOND = "2026-12-31T23:59:60Z";

/** Documents reviewed before the decision, one version of each. */
function reviewedDocuments() {
  return [
    { documentKind: "threat_model", documentSha256: THREAT_MODEL, reviewedAt: "2026-07-20T00:00:00.000Z" },
    { documentKind: "data_inventory", documentSha256: DATA_INVENTORY, reviewedAt: "2026-07-20T00:00:00.000Z" },
    { documentKind: "retention_policy", documentSha256: RETENTION_POLICY, reviewedAt: "2026-07-21T00:00:00.000Z" },
  ];
}

function scope(override: Record<string, unknown> = {}) {
  return {
    schoolRef: SCHOOL,
    classRef: CLASSROOM,
    roomIds: [ROOM],
    maxStudentsPerRoom: 4,
    maxStudentsTotal: 24,
    sessionsFrom: "2026-09-01T00:00:00.000Z",
    sessionsUntil: "2026-10-01T00:00:00.000Z",
    ...override,
  };
}

function providerScope(override: Record<string, unknown> = {}) {
  return {
    providerId: "fixture",
    providerManifestSha256: PROVIDER_MANIFEST,
    region: "hk",
    purpose: "pilot-inference",
    remoteCopyMode: "no_persistent_copy_attested",
    copyAuthorityRecordSha256: COPY_AUTHORITY,
    copyAuthorityExpiresAt: "2026-12-01T00:00:00.000Z",
    ...override,
  };
}

function record(override: Record<string, unknown> = {}) {
  return {
    recordKind: "external_authorization",
    authorizationId: "22222222-2222-4222-8222-222222222222",
    synthetic: false,
    authorizingBody: {
      bodyKind: "school_and_research_ethics_board",
      bodyRef: BODY,
      approvalReference: "learning-orbit-test-only/not-an-authorization",
      decidedAt: "2026-08-01T00:00:00.000Z",
    },
    scope: scope(),
    supervisingTeacherRef: TEACHER,
    rollbackOwnerRef: ROLLBACK,
    incidentContactRefs: [CONTACT],
    participantInformation: {
      informationSheetSha256: SHEET,
      consentPath: "guardian_and_student_written_opt_in",
      consentObtainedBy: "2026-08-20T00:00:00.000Z",
    },
    reviewedDocuments: reviewedDocuments(),
    retentionPolicyId: "33333333-3333-4333-8333-333333333333",
    providerScope: providerScope(),
    featureAllowlist: ["room_chat", "media_upload", "agent_nova", "teacher_analytics"],
    usedForGradesOrDiscipline: false,
    authorizedSignerRefs: [SIGNER],
    ...override,
  };
}

describe("external school and ethics authorization record", () => {
  it("accepts a decision that names every dimension of its own scope", () => {
    const parsed = externalAuthorizationRecordContract.parse(record());
    expect(parsed.scope.roomIds).toEqual([ROOM]);
    // Student-visible analytics are not in this record's vocabulary at all.
    expect([...parsed.featureAllowlist]).not.toContain("trace.student_bundle");
  });

  it("refuses a rehearsal of the paperwork offered as a decision", () => {
    expect(() => externalAuthorizationRecordContract.parse(record({ synthetic: true })))
      .toThrow("AUTHORIZATION_WAS_SYNTHETIC");
  });

  it("refuses an approval the party running the pilot issued to itself", () => {
    expect(() => externalAuthorizationRecordContract.parse(record({
      authorizingBody: { ...record().authorizingBody, bodyRef: TEACHER },
    }))).toThrow("AUTHORIZATION_SELF_ISSUED");
    expect(() => externalAuthorizationRecordContract.parse(record({
      authorizingBody: { ...record().authorizingBody, bodyRef: CONTACT },
    }))).toThrow("AUTHORIZATION_SELF_ISSUED");
  });

  it("refuses sessions covered before the body decided anything", () => {
    expect(() => externalAuthorizationRecordContract.parse(record({
      scope: scope({ sessionsFrom: "2026-07-01T00:00:00.000Z" }),
    }))).toThrow("AUTHORIZATION_DECISION_OUT_OF_ORDER");
  });

  it("refuses a document version reviewed after the decision it informed", () => {
    const [threatModel, ...rest] = reviewedDocuments();
    expect(() => externalAuthorizationRecordContract.parse(record({
      reviewedDocuments: [{ ...threatModel, reviewedAt: "2026-08-15T00:00:00.000Z" }, ...rest],
    }))).toThrow("AUTHORIZATION_DECISION_OUT_OF_ORDER");
  });

  it("refuses a decision that never looked at one of the required documents", () => {
    const [threatModel, , retentionPolicy] = reviewedDocuments();
    expect(() => externalAuthorizationRecordContract.parse(record({
      reviewedDocuments: [threatModel, threatModel, retentionPolicy],
    }))).toThrow("AUTHORIZATION_REVIEWED_DOCUMENTS_INCOMPLETE");
  });

  it("refuses a window long enough to be a standing permission", () => {
    expect(() => externalAuthorizationRecordContract.parse(record({
      scope: scope({ sessionsUntil: "2027-09-01T00:00:00.000Z" }),
    }))).toThrow("AUTHORIZATION_SCOPE_UNBOUNDED");
  });

  it("refuses a per-room cap larger than the cohort it is drawn from", () => {
    // A cap above the whole cohort is a number that can never refuse anyone.
    expect(() => externalAuthorizationRecordContract.parse(record({
      scope: scope({ maxStudentsPerRoom: 40, maxStudentsTotal: 24 }),
    }))).toThrow("AUTHORIZATION_SCOPE_UNBOUNDED");
  });

  it("refuses sessions beginning before consent was held", () => {
    expect(() => externalAuthorizationRecordContract.parse(record({
      participantInformation: {
        ...record().participantInformation,
        consentObtainedBy: "2026-09-15T00:00:00.000Z",
      },
    }))).toThrow("AUTHORIZATION_CONSENT_NOT_OBTAINED_BEFORE_SESSIONS");
  });

  it("refuses a provider scope carrying the other copy mode's fields", () => {
    expect(() => externalAuthorizationRecordContract.parse(record({
      providerScope: providerScope({ capabilitySchemaVersion: "v1", portSchemaVersion: "v1" }),
    }))).toThrow("AUTHORIZATION_PROVIDER_SCOPE_MISMATCH");
  });

  it("refuses an attestation that lapses before the last authorised session", () => {
    expect(() => externalAuthorizationRecordContract.parse(record({
      providerScope: providerScope({ copyAuthorityExpiresAt: "2026-09-15T00:00:00.000Z" }),
    }))).toThrow("AUTHORIZATION_PROVIDER_SCOPE_MISMATCH");
  });

  it("accepts delete-and-probe only when it names the reviewed schema versions", () => {
    const probe = {
      providerId: "fixture",
      providerManifestSha256: PROVIDER_MANIFEST,
      region: "hk",
      purpose: "pilot-inference",
      remoteCopyMode: "delete_and_probe",
      capabilitySchemaVersion: "capability-v1",
      portSchemaVersion: "port-v1",
    };
    expect(externalAuthorizationRecordContract.parse(record({ providerScope: probe })).providerScope.remoteCopyMode)
      .toBe("delete_and_probe");
    const { capabilitySchemaVersion: _capability, ...unnamed } = probe;
    expect(() => externalAuthorizationRecordContract.parse(record({ providerScope: unnamed })))
      .toThrow("AUTHORIZATION_PROVIDER_SCOPE_MISMATCH");
  });

  it("refuses a decision that says the analytics feed grades or discipline", () => {
    expect(() => externalAuthorizationRecordContract.parse(record({ usedForGradesOrDiscipline: true })))
      .toThrow("AUTHORIZATION_USED_FOR_GRADES_OR_DISCIPLINE");
  });

  it("refuses a body whose named signer is a party running the pilot", () => {
    // A signer who supervises the sessions, owns the rollback, or takes the
    // incident calls is the pilot approving itself one indirection out.
    for (const ref of [TEACHER, ROLLBACK, CONTACT]) {
      expect(() => externalAuthorizationRecordContract.parse(record({ authorizedSignerRefs: [SIGNER, ref] })))
        .toThrow("AUTHORIZATION_SELF_ISSUED");
    }
  });

  it("refuses a decision date that never happened rather than comparing against NaN", () => {
    // `format: "date-time"` admits a leap second; `Date.parse` cannot place
    // it, and NaN loses every comparison. Read literally, this record was
    // decided after documents reviewed in 2027 for sessions run in 2020.
    expect(() => externalAuthorizationRecordContract.parse(record({
      authorizingBody: { ...record().authorizingBody, decidedAt: LEAP_SECOND },
      scope: scope({ sessionsFrom: "2020-01-01T00:00:00.000Z", sessionsUntil: "2020-02-01T00:00:00.000Z" }),
      reviewedDocuments: reviewedDocuments().map((entry) => ({ ...entry, reviewedAt: "2027-07-20T00:00:00.000Z" })),
      participantInformation: { ...record().participantInformation, consentObtainedBy: "2019-01-01T00:00:00.000Z" },
      providerScope: providerScope({ copyAuthorityExpiresAt: "2020-03-01T00:00:00.000Z" }),
    }))).toThrow("INVALID_EXTERNAL_AUTHORIZATION_RECORD");
  });

  it("refuses a consent date that never happened rather than reading it as held in time", () => {
    // The guardian-consent refusal is the one this NaN hole walked through.
    expect(() => externalAuthorizationRecordContract.parse(record({
      participantInformation: { ...record().participantInformation, consentObtainedBy: LEAP_SECOND },
    }))).toThrow("INVALID_EXTERNAL_AUTHORIZATION_RECORD");
  });

  it("refuses an attestation expiry that never happened rather than reading it as covering the window", () => {
    expect(() => externalAuthorizationRecordContract.parse(record({
      providerScope: providerScope({ copyAuthorityExpiresAt: LEAP_SECOND }),
    }))).toThrow("INVALID_EXTERNAL_AUTHORIZATION_RECORD");
  });

  it("refuses a reviewed-document date or a session bound that never happened", () => {
    const [threatModel, ...rest] = reviewedDocuments();
    expect(() => externalAuthorizationRecordContract.parse(record({
      reviewedDocuments: [{ ...threatModel, reviewedAt: LEAP_SECOND }, ...rest],
    }))).toThrow("INVALID_EXTERNAL_AUTHORIZATION_RECORD");
    expect(() => externalAuthorizationRecordContract.parse(record({ scope: scope({ sessionsFrom: LEAP_SECOND }) })))
      .toThrow("INVALID_EXTERNAL_AUTHORIZATION_RECORD");
    expect(() => externalAuthorizationRecordContract.parse(record({ scope: scope({ sessionsUntil: LEAP_SECOND }) })))
      .toThrow("INVALID_EXTERNAL_AUTHORIZATION_RECORD");
  });

  it("refuses a payload reaching past the vocabulary it was given", () => {
    // Student-visible projections are a separate signed decision and cannot be
    // reached from here; a wildcard room is not a room; a field nobody
    // contracted is a scope nobody reviewed.
    expect(() => externalAuthorizationRecordContract.parse(record({
      featureAllowlist: ["room_chat", "trace.student_bundle"],
    }))).toThrow("INVALID_EXTERNAL_AUTHORIZATION_RECORD");
    expect(() => externalAuthorizationRecordContract.parse(record({ scope: scope({ roomIds: ["*"] }) })))
      .toThrow("INVALID_EXTERNAL_AUTHORIZATION_RECORD");
    expect(() => externalAuthorizationRecordContract.parse(record({ studentRoster: ["a student"] })))
      .toThrow("INVALID_EXTERNAL_AUTHORIZATION_RECORD");
    expect(() => externalAuthorizationRecordContract.parse(record({ scope: scope({ schoolRef: "Example Secondary School" }) })))
      .toThrow("INVALID_EXTERNAL_AUTHORIZATION_RECORD");
  });
});
