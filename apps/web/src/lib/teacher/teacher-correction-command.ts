import {
  analyticsContract,
  type AnalyticsReviewCommand,
} from "@learning-orbit/contracts";

type CorrectionCommand = Exclude<AnalyticsReviewCommand, { decision: string }>;
export type TeacherCorrectionKind = CorrectionCommand["correctionKind"];

type EvidenceRef = Readonly<{ eventId: string; start: number; end: number }>;
type RetractTarget = Readonly<{
  targetType: "derived_text" | "evidence" | "projection";
  targetId: string;
}>;

export type TeacherCorrectionDraft = Readonly<{
  correctionKind: TeacherCorrectionKind;
  reason: string;
  expectedAnalysisEpoch: string;
  expectedProjectionVersion: number;
  artifactId?: string;
  projectionEdgeId?: string;
  targetEvidence?: EvidenceRef;
  replacementEvidence?: EvidenceRef;
  canonicalNodeId?: string;
  aliasNodeId?: string;
  mergeReviewEventId?: string;
  retractTarget?: RetractTarget;
  replacementText?: string;
  languageTag?: string;
  replacementHead?: string;
  replacementPredicate?: string;
  replacementTail?: string;
  replacementRelationFamily?: string;
  newCanonicalNodeId?: string;
  newLabel?: string;
}>;

function required(value: string | undefined, code: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(code);
  return value.trim();
}

function evidence(value: EvidenceRef | undefined): EvidenceRef {
  if (!value) throw new Error("CORRECTION_EVIDENCE_REQUIRED");
  return value;
}

/**
 * Turn the local form state into the canonical generated seven-branch union.
 * This helper never invents server version/epoch authority and validates the
 * exact result before it can reach SessionGateway.
 */
export function buildTeacherCorrectionCommand(draft: TeacherCorrectionDraft): CorrectionCommand {
  const common = {
    reason: required(draft.reason, "CORRECTION_REASON_REQUIRED"),
    expectedAnalysisEpoch: draft.expectedAnalysisEpoch,
    expectedProjectionVersion: draft.expectedProjectionVersion,
  } as const;
  let command: CorrectionCommand;
  switch (draft.correctionKind) {
    case "replace_text":
      command = {
        ...common,
        correctionKind: "replace_text",
        targetArtifactId: required(draft.artifactId, "CORRECTION_ARTIFACT_REQUIRED"),
        replacement: {
          text: required(draft.replacementText, "CORRECTION_TEXT_REQUIRED"),
          languageTag: required(draft.languageTag, "CORRECTION_LANGUAGE_REQUIRED"),
        },
      };
      break;
    case "replace_evidence_span":
      command = {
        ...common,
        correctionKind: "replace_evidence_span",
        targetProjectionEdgeId: required(draft.projectionEdgeId, "CORRECTION_EDGE_REQUIRED"),
        target: evidence(draft.targetEvidence),
        replacement: evidence(draft.replacementEvidence),
      };
      break;
    case "replace_relation":
      command = {
        ...common,
        correctionKind: "replace_relation",
        targetProjectionEdgeId: required(draft.projectionEdgeId, "CORRECTION_EDGE_REQUIRED"),
        replacement: {
          head: required(draft.replacementHead, "CORRECTION_HEAD_REQUIRED"),
          predicate: required(draft.replacementPredicate, "CORRECTION_PREDICATE_REQUIRED"),
          tail: required(draft.replacementTail, "CORRECTION_TAIL_REQUIRED"),
          relationFamily: required(draft.replacementRelationFamily, "CORRECTION_RELATION_FAMILY_REQUIRED"),
        },
      };
      break;
    case "merge_alias":
      command = {
        ...common,
        correctionKind: "merge_alias",
        targetCanonicalNodeId: required(draft.canonicalNodeId, "CORRECTION_CANONICAL_NODE_REQUIRED"),
        replacement: { aliasNodeId: required(draft.aliasNodeId, "CORRECTION_ALIAS_NODE_REQUIRED") },
      };
      break;
    case "split_alias":
      command = {
        ...common,
        correctionKind: "split_alias",
        targetCanonicalNodeId: required(draft.canonicalNodeId, "CORRECTION_CANONICAL_NODE_REQUIRED"),
        replacement: {
          aliasNodeId: required(draft.aliasNodeId, "CORRECTION_ALIAS_NODE_REQUIRED"),
          newCanonicalNodeId: required(draft.newCanonicalNodeId, "CORRECTION_NEW_NODE_REQUIRED"),
          newLabel: required(draft.newLabel, "CORRECTION_NEW_LABEL_REQUIRED"),
        },
      };
      break;
    case "undo_merge":
      command = {
        ...common,
        correctionKind: "undo_merge",
        targetCorrectionEventId: required(draft.mergeReviewEventId, "CORRECTION_MERGE_REQUIRED"),
        replacement: {},
      };
      break;
    case "retract": {
      const target = draft.retractTarget;
      if (!target) throw new Error("CORRECTION_RETRACT_TARGET_REQUIRED");
      command = {
        ...common,
        correctionKind: "retract",
        targetType: target.targetType,
        targetId: required(target.targetId, "CORRECTION_RETRACT_TARGET_REQUIRED"),
        replacement: {},
      };
      break;
    }
  }
  return analyticsContract.parseReview(command) as CorrectionCommand;
}
