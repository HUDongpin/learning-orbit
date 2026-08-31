/* generated; source is JSON Schema */

export type AnalyticsTeacherHttpResponse = AnalyticsReviewAccepted | AnalyticsReviewDetail;
export type AnalyticsReviewCommand =
  | AnalyticsReviewInput
  | ReplaceTextCorrection
  | ReplaceEvidenceSpanCorrection
  | ReplaceRelationCorrection
  | MergeAliasCorrection
  | SplitAliasCorrection
  | UndoMergeCorrection
  | RetractCorrection;

export interface AnalyticsReviewAccepted {
  schemaVersion: 1;
  reviewEventId: string;
  changeKind: "review" | "correction";
  replayJobId: string;
}
export interface AnalyticsReviewDetail {
  schemaVersion: 1;
  reviewEventId: string;
  roomId: string;
  changeKind: "review" | "correction";
  payload: AnalyticsReviewCommand;
  createdAt: string;
}
export interface AnalyticsReviewInput {
  targetType: "derived_text" | "evidence" | "projection";
  targetId: string;
  decision: "review_pass" | "review_concerns" | "review_fail" | "approve" | "reject" | "revoke";
  rationale: string;
  expectedAnalysisEpoch: string;
  expectedProjectionVersion: number;
}
export interface ReplaceTextCorrection {
  targetArtifactId: string;
  correctionKind: "replace_text";
  replacement: {
    text: string;
    languageTag: string;
  };
  reason: string;
  expectedAnalysisEpoch: string;
  expectedProjectionVersion: number;
}
export interface ReplaceEvidenceSpanCorrection {
  targetProjectionEdgeId: string;
  correctionKind: "replace_evidence_span";
  target: EvidenceRef;
  replacement: EvidenceRef;
  reason: string;
  expectedAnalysisEpoch: string;
  expectedProjectionVersion: number;
}
export interface EvidenceRef {
  eventId: string;
  start: number;
  end: number;
}
export interface ReplaceRelationCorrection {
  targetProjectionEdgeId: string;
  correctionKind: "replace_relation";
  replacement: RelationReplacement;
  reason: string;
  expectedAnalysisEpoch: string;
  expectedProjectionVersion: number;
}
export interface RelationReplacement {
  head: string;
  predicate: string;
  tail: string;
  relationFamily: string;
}
export interface MergeAliasCorrection {
  targetCanonicalNodeId: string;
  correctionKind: "merge_alias";
  replacement: {
    aliasNodeId: string;
  };
  reason: string;
  expectedAnalysisEpoch: string;
  expectedProjectionVersion: number;
}
export interface SplitAliasCorrection {
  targetCanonicalNodeId: string;
  correctionKind: "split_alias";
  replacement: {
    aliasNodeId: string;
    newCanonicalNodeId: string;
    newLabel: string;
  };
  reason: string;
  expectedAnalysisEpoch: string;
  expectedProjectionVersion: number;
}
export interface UndoMergeCorrection {
  targetCorrectionEventId: string;
  correctionKind: "undo_merge";
  replacement: EmptyReplacement;
  reason: string;
  expectedAnalysisEpoch: string;
  expectedProjectionVersion: number;
}
export interface EmptyReplacement {}
export interface RetractCorrection {
  targetType: "derived_text" | "evidence" | "projection";
  targetId: string;
  correctionKind: "retract";
  replacement: EmptyReplacement;
  reason: string;
  expectedAnalysisEpoch: string;
  expectedProjectionVersion: number;
}
