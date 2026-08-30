import { describe, expect, it } from "vitest";

import { analyticsContract, type ConceptMapPatch, type ConceptMapSnapshot } from "@learning-orbit/contracts";
import goldenEcho from "../../../../../packages/test-fixtures/analytics/golden-echo-projection.json" with { type: "json" };
import { applyConceptPatch } from "./concept-reducer.js";

const EDGE_TWO = "00000000-0000-5000-8000-000000000202";
const EDGE_THREE = "00000000-0000-5000-8000-000000000203";
const EVENT_TWO = "00000000-0000-4000-8000-000000000102";

function snapshot(): ConceptMapSnapshot {
  return analyticsContract.parseEchoSnapshot({
    ...goldenEcho,
    payload: {
      nodes: [
        ...goldenEcho.payload.nodes,
        {
          ...goldenEcho.payload.nodes[0],
          nodeId: "decomposer",
          label: "分解者",
          position: { x: 0.5, y: 0.8 },
        },
      ],
      edges: [
        ...goldenEcho.payload.edges,
        {
          ...goldenEcho.payload.edges[0],
          edgeId: EDGE_TWO,
          head: "producers",
          predicate: "feeds",
          tail: "decomposer",
          evidenceRefs: [{ eventId: EVENT_TWO, start: 0, end: 3 }],
        },
      ],
    },
  });
}

function patch(): ConceptMapPatch {
  return analyticsContract.parseEchoPatch({
    analysisEpoch: goldenEcho.analysisEpoch,
    algorithmVersion: goldenEcho.algorithmVersion,
    parameterHash: goldenEcho.parameterHash,
    projectionVersion: 2,
    baseVersion: 1,
    completeThroughRoomSeq: 8,
    requiresReplay: false,
    warnings: ["layout_recalculated"],
    nodesAdded: [{
      ...goldenEcho.payload.nodes[0],
      nodeId: "nutrient",
      label: "養分",
      position: { x: 0.2, y: 0.8 },
    }],
    nodesUpdated: [{
      ...goldenEcho.payload.nodes[0],
      label: "太陽能",
      position: { x: 0.2, y: 0.2 },
    }],
    nodesHidden: ["decomposer"],
    edgesAdded: [{
      ...goldenEcho.payload.edges[0],
      edgeId: EDGE_THREE,
      head: "nutrient",
      predicate: "supports",
      tail: "producers",
      evidenceRefs: [{ eventId: EVENT_TWO, start: 4, end: 7 }],
    }],
    edgesUpdated: [{
      ...goldenEcho.payload.edges[0],
      predicate: "把能量傳給",
      activityScore: 2,
    }],
    edgesHidden: [EDGE_TWO],
    positionUpdates: [{ nodeId: "producers", x: 0.8, y: 0.3 }],
    changeScore: 0.75,
    reasonCodes: ["new_evidence"],
    evidenceRefs: [{ eventId: EVENT_TWO, start: 4, end: 7 }],
  });
}

describe("server ECHO ConceptMapPatch reducer", () => {
  it("applies every generated patch branch atomically without mutating the prior snapshot", () => {
    const before = snapshot();
    const frozen = structuredClone(before);
    const after = applyConceptPatch(before, patch());

    expect(before).toEqual(frozen);
    expect(after).toMatchObject({ projectionVersion: 2, baseVersion: 1, completeThroughRoomSeq: 8 });
    expect(after.payload.nodes.map(({ nodeId }) => nodeId).sort()).toEqual(["nutrient", "producers", "sun"]);
    expect(after.payload.nodes.find(({ nodeId }) => nodeId === "sun")?.label).toBe("太陽能");
    expect(after.payload.nodes.find(({ nodeId }) => nodeId === "producers")?.position).toEqual({ x: 0.8, y: 0.3 });
    expect(after.payload.edges.map(({ edgeId }) => edgeId).sort()).toEqual([
      goldenEcho.payload.edges[0]!.edgeId,
      EDGE_THREE,
    ].sort());
    expect(after.payload.edges.find(({ edgeId }) => edgeId === goldenEcho.payload.edges[0]!.edgeId))
      .toMatchObject({ predicate: "把能量傳給", activityScore: 2 });
    expect(after.warnings).toEqual(["layout_recalculated"]);
  });

  it("rejects baseline, epoch, replay, unknown mutation, and dangling-endpoint failures", () => {
    const before = snapshot();
    const valid = patch();
    for (const invalid of [
      { ...valid, baseVersion: 0 },
      { ...valid, analysisEpoch: "00000000-0000-4000-8000-000000000999" },
      { ...valid, requiresReplay: true },
      { ...valid, nodesUpdated: [{ ...valid.nodesUpdated[0]!, nodeId: "missing" }] },
      { ...valid, edgesAdded: [{ ...valid.edgesAdded[0]!, tail: "missing" }] },
    ]) {
      expect(() => applyConceptPatch(before, invalid as ConceptMapPatch)).toThrow(/CONCEPT_PATCH_/u);
      expect(before).toEqual(snapshot());
    }
  });
});
