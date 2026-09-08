/* generated; source is JSON Schema */

/**
 * The separate decision that lets students see the analytics built from their own conversation. It is never inferred from a completed shadow: "the agent behaved acceptably in a room with one adult in it" and "students may see their own analytics" are different questions. Default-deny is the resting state, so the record must name the projection keys out loud - an empty list is chat-only, and no list at all is refused.
 */
export interface StudentVisiblePromotionRecord {
  recordKind: "student_visible_promotion";
  promotionId: string;
  /**
   * The one room this decision covers. Promotion is a whole-room decision and is never made for a cohort in the abstract.
   */
  roomId: string;
  /**
   * A synthetic record is a rehearsal of the paperwork and is not a promotion. True is refused.
   */
  synthetic: boolean;
  /**
   * The digest of the signed external authorization this promotion rests on.
   */
  externalAuthorizationRecordSha256: string;
  /**
   * The start of the window that authorization granted, restated so this record can be refused on its own. The importer must still compare it with the verified authorization record; a restatement is not the record.
   */
  authorizedFrom: string;
  authorizedUntil: string;
  /**
   * The digest of the signed completed shadow. Named so the two decisions can be linked, not so one can be derived from the other.
   */
  shadowRecordSha256: string;
  /**
   * The teacher who ran that shadow, as a salted digest. A promotion signed by that same person is refused: one person answering both questions at once tends to answer the second by momentum.
   */
  shadowTeacherRef: string;
  shadowVerdict: "ready_for_students" | "not_ready";
  /**
   * Whether this promotion was derived from the shadow rather than decided. True is refused.
   */
  derivedFromShadowRecord: boolean;
  /**
   * Who decided, as a salted digest, and when.
   */
  decidedBy: {
    deciderRef: string;
    deciderRole: "school_authority" | "research_ethics_board" | "designated_release_custodian";
    decidedAt: string;
  };
  /**
   * The projections a student in this room may be shown. Zero, one or both, named explicitly: an empty list is a promotion to chat-only operation, which is the resting state anyway.
   *
   * @maxItems 2
   */
  studentProjectionKeys:
    | []
    | ["echo.student_approved" | "trace.student_bundle"]
    | ["echo.student_approved" | "trace.student_bundle", "echo.student_approved" | "trace.student_bundle"];
  startsAt: string;
  expiresAt: string;
  /**
   * How this visibility is withdrawn before it expires. A path that cannot act inside the window it governs is not a revocation path.
   */
  revocation: {
    contactRef: string;
    method: "signed_revocation_record" | "operator_revoke_command";
    maxLatencyMinutes: number;
  };
  /**
   * Whether what the student is shown feeds grades or discipline. True is refused.
   */
  usedForGradesOrDiscipline: boolean;
}
