import { describe, expect, it } from "vitest";

import { analyticsContract } from "@learning-orbit/contracts";
import {
  buildTeacherCorrectionCommand,
  type TeacherCorrectionDraft,
} from "./teacher-correction-command.js";

const UUID = {
  epoch: "00000000-0000-4000-8000-000000000001",
  artifact: "00000000-0000-4000-8000-000000000002",
  edge: "00000000-0000-4000-8000-000000000003",
  event: "00000000-0000-4000-8000-000000000004",
  replacementEvent: "00000000-0000-4000-8000-000000000005",
  merge: "00000000-0000-4000-8000-000000000006",
} as const;
const base = {
  reason: "依據課堂證據修正。",
  expectedAnalysisEpoch: UUID.epoch,
  expectedProjectionVersion: 4,
} as const;

describe("teacher seven-branch correction builder", () => {
  it.each([
    { ...base, correctionKind: "replace_text", artifactId: UUID.artifact, replacementText: "生產者吸收光能。", languageTag: "zh-Hant" },
    { ...base, correctionKind: "replace_evidence_span", projectionEdgeId: UUID.edge, targetEvidence: { eventId: UUID.event, start: 0, end: 2 }, replacementEvidence: { eventId: UUID.replacementEvent, start: 1, end: 4 } },
    { ...base, correctionKind: "replace_relation", projectionEdgeId: UUID.edge, replacementHead: "producer", replacementPredicate: "uses", replacementTail: "sunlight", replacementRelationFamily: "energy_flow" },
    { ...base, correctionKind: "merge_alias", canonicalNodeId: "producer", aliasNodeId: "plant" },
    { ...base, correctionKind: "split_alias", canonicalNodeId: "producer", aliasNodeId: "plant", newCanonicalNodeId: "aquatic-plant", newLabel: "水生植物" },
    { ...base, correctionKind: "undo_merge", mergeReviewEventId: UUID.merge },
    { ...base, correctionKind: "retract", retractTarget: { targetType: "projection", targetId: UUID.edge } },
  ] satisfies TeacherCorrectionDraft[])("builds and validates $correctionKind without mixed fields", (draft) => {
    const command = buildTeacherCorrectionCommand(draft);
    expect(analyticsContract.parseReview(command)).toEqual(command);
    expect(command).toMatchObject({
      correctionKind: draft.correctionKind,
      expectedAnalysisEpoch: UUID.epoch,
      expectedProjectionVersion: 4,
    });
  });

  it("fails before network submission when required local form authority is absent", () => {
    expect(() => buildTeacherCorrectionCommand({
      ...base,
      correctionKind: "undo_merge",
    })).toThrow("CORRECTION_MERGE_REQUIRED");
  });
});
