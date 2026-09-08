import { describe, expect, it } from "vitest";

import { studentVisiblePromotionRecordContract } from "../src/governance.js";

const AUTHORIZATION = "a".repeat(64);
const SHADOW = "b".repeat(64);
const SHADOW_TEACHER = "7".repeat(64);
const DECIDER = "9".repeat(64);
const REVOCATION_CONTACT = "e".repeat(64);
const ROOM = "11111111-1111-4111-8111-111111111111";
/** Well-formed to `format: "date-time"`, unplaceable to `Date.parse`. */
const LEAP_SECOND = "2026-12-31T23:59:60Z";

function record(override: Record<string, unknown> = {}) {
  return {
    recordKind: "student_visible_promotion",
    promotionId: "22222222-2222-4222-8222-222222222222",
    roomId: ROOM,
    synthetic: false,
    externalAuthorizationRecordSha256: AUTHORIZATION,
    authorizedFrom: "2026-09-01T00:00:00.000Z",
    authorizedUntil: "2026-10-01T00:00:00.000Z",
    shadowRecordSha256: SHADOW,
    shadowTeacherRef: SHADOW_TEACHER,
    shadowVerdict: "ready_for_students",
    derivedFromShadowRecord: false,
    decidedBy: {
      deciderRef: DECIDER,
      deciderRole: "school_authority",
      decidedAt: "2026-09-02T00:00:00.000Z",
    },
    studentProjectionKeys: ["echo.student_approved", "trace.student_bundle"],
    startsAt: "2026-09-03T00:00:00.000Z",
    expiresAt: "2026-09-30T00:00:00.000Z",
    revocation: {
      contactRef: REVOCATION_CONTACT,
      method: "operator_revoke_command",
      maxLatencyMinutes: 60,
    },
    usedForGradesOrDiscipline: false,
    ...override,
  };
}

describe("student visibility promotion record", () => {
  it("accepts a decision that names the keys it opens", () => {
    const parsed = studentVisiblePromotionRecordContract.parse(record());
    expect([...parsed.studentProjectionKeys]).toEqual(["echo.student_approved", "trace.student_bundle"]);
    expect(parsed.roomId).toBe(ROOM);
  });

  it("accepts an explicitly empty list as a decision to stay chat-only", () => {
    // Default deny is the resting state; saying so out loud is still a
    // decision, and is the only way to say it.
    const parsed = studentVisiblePromotionRecordContract.parse(record({ studentProjectionKeys: [] }));
    expect(parsed.studentProjectionKeys).toHaveLength(0);
  });

  it("refuses a rehearsal of the paperwork offered as a promotion", () => {
    expect(() => studentVisiblePromotionRecordContract.parse(record({ synthetic: true })))
      .toThrow("PROMOTION_WAS_SYNTHETIC");
  });

  it("refuses a promotion derived from the shadow instead of decided", () => {
    expect(() => studentVisiblePromotionRecordContract.parse(record({ derivedFromShadowRecord: true })))
      .toThrow("PROMOTION_INFERRED_FROM_SHADOW");
  });

  it("refuses the teacher who ran the shadow signing off on the promotion", () => {
    // Two different questions; one person answering both at once tends to
    // answer the second by momentum.
    expect(() => studentVisiblePromotionRecordContract.parse(record({
      decidedBy: { ...record().decidedBy, deciderRef: SHADOW_TEACHER },
    }))).toThrow("PROMOTION_DECIDED_BY_SHADOW_TEACHER");
  });

  it("refuses visibility that began before the decision that opened it", () => {
    expect(() => studentVisiblePromotionRecordContract.parse(record({
      decidedBy: { ...record().decidedBy, decidedAt: "2026-09-20T00:00:00.000Z" },
    }))).toThrow("PROMOTION_DECISION_OUT_OF_ORDER");
  });

  it("refuses a window reaching outside the authorization it rests on", () => {
    expect(() => studentVisiblePromotionRecordContract.parse(record({
      expiresAt: "2026-10-15T00:00:00.000Z",
    }))).toThrow("PROMOTION_SCOPE_EXCEEDS_AUTHORIZATION");
    expect(() => studentVisiblePromotionRecordContract.parse(record({
      startsAt: "2026-08-20T00:00:00.000Z", decidedBy: { ...record().decidedBy, decidedAt: "2026-08-19T00:00:00.000Z" },
    }))).toThrow("PROMOTION_SCOPE_EXCEEDS_AUTHORIZATION");
  });

  it("refuses keys opened over a shadow that said not ready", () => {
    expect(() => studentVisiblePromotionRecordContract.parse(record({ shadowVerdict: "not_ready" })))
      .toThrow("PROMOTION_CONTRADICTS_SHADOW_VERDICT");
  });

  it("allows a not-ready shadow to be recorded alongside no keys at all", () => {
    const parsed = studentVisiblePromotionRecordContract.parse(record({
      shadowVerdict: "not_ready", studentProjectionKeys: [],
    }));
    expect(parsed.shadowVerdict).toBe("not_ready");
  });

  it("refuses a revocation slower than the grant it withdraws", () => {
    expect(() => studentVisiblePromotionRecordContract.parse(record({
      expiresAt: "2026-09-03T00:30:00.000Z",
    }))).toThrow("PROMOTION_REVOCATION_PATH_INEFFECTIVE");
  });

  it("refuses a promotion that says what students see feeds grades", () => {
    expect(() => studentVisiblePromotionRecordContract.parse(record({ usedForGradesOrDiscipline: true })))
      .toThrow("PROMOTION_USED_FOR_GRADES_OR_DISCIPLINE");
  });

  it("refuses a record that leaves the decision to be inferred", () => {
    // An absent list is not a decision, a repeated key is not two decisions,
    // and a teacher projection is not a student's to be shown.
    const { studentProjectionKeys: _keys, ...silent } = record();
    expect(() => studentVisiblePromotionRecordContract.parse(silent))
      .toThrow("INVALID_STUDENT_VISIBLE_PROMOTION_RECORD");
    expect(() => studentVisiblePromotionRecordContract.parse(record({
      studentProjectionKeys: ["echo.student_approved", "echo.student_approved"],
    }))).toThrow("INVALID_STUDENT_VISIBLE_PROMOTION_RECORD");
    expect(() => studentVisiblePromotionRecordContract.parse(record({
      studentProjectionKeys: ["trace.teacher_bundle"],
    }))).toThrow("INVALID_STUDENT_VISIBLE_PROMOTION_RECORD");
    expect(() => studentVisiblePromotionRecordContract.parse(record({ roomId: "every-room" })))
      .toThrow("INVALID_STUDENT_VISIBLE_PROMOTION_RECORD");
  });

  it("refuses a decision date that never happened rather than comparing against NaN", () => {
    // `format: "date-time"` admits a leap second; `Date.parse` cannot place
    // it, and NaN loses every comparison, so the out-of-order refusal below
    // would pass a promotion decided after the visibility it opens.
    expect(() => studentVisiblePromotionRecordContract.parse(record({
      decidedBy: { ...record().decidedBy, decidedAt: LEAP_SECOND },
    }))).toThrow("INVALID_STUDENT_VISIBLE_PROMOTION_RECORD");
  });

  it("refuses a window bound that never happened", () => {
    for (const field of ["startsAt", "expiresAt", "authorizedFrom", "authorizedUntil"]) {
      expect(() => studentVisiblePromotionRecordContract.parse(record({ [field]: LEAP_SECOND })))
        .toThrow("INVALID_STUDENT_VISIBLE_PROMOTION_RECORD");
    }
  });

  it("refuses an expiry at or before its own start", () => {
    expect(() => studentVisiblePromotionRecordContract.parse(record({
      startsAt: "2026-09-10T00:00:00.000Z", expiresAt: "2026-09-04T00:00:00.000Z",
    }))).toThrow("INVALID_STUDENT_VISIBLE_PROMOTION_RECORD");
  });
});
