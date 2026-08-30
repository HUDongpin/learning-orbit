import {
  analyticsContract,
  type ConceptMapPatch,
  type ConceptMapSnapshot,
} from "@learning-orbit/contracts";

function fail(code: string): never { throw new Error(code); }

type PayloadNode<T> = T extends { payload: { nodes: Array<infer Node> } } ? Node : never;
type PayloadEdge<T> = T extends { payload: { edges: Array<infer Edge> } } ? Edge : never;
type ProjectionNode = PayloadNode<ConceptMapSnapshot>;
type ProjectionEdge = PayloadEdge<ConceptMapSnapshot>;

function cloneEdge<Edge extends ProjectionEdge>(edge: Edge): Edge {
  const cloned: Record<string, unknown> = { ...edge };
  if ("channels" in edge && edge.channels && typeof edge.channels === "object") {
    cloned.channels = { ...edge.channels };
  }
  if ("evidenceRefs" in edge && Array.isArray(edge.evidenceRefs)) {
    cloned.evidenceRefs = edge.evidenceRefs.map((reference) => ({ ...reference }));
  }
  return cloned as Edge;
}

export function applyConceptPatch(
  snapshot: ConceptMapSnapshot,
  patch: ConceptMapPatch,
): ConceptMapSnapshot {
  if (snapshot.requiresReplay || snapshot.evidenceStatus !== "active" || patch.requiresReplay) {
    return fail("CONCEPT_PATCH_REPLAY_REQUIRED");
  }
  if (patch.analysisEpoch !== snapshot.analysisEpoch) return fail("CONCEPT_PATCH_EPOCH_MISMATCH");
  if (patch.algorithmVersion !== snapshot.algorithmVersion
    || patch.parameterHash !== snapshot.parameterHash) return fail("CONCEPT_PATCH_BASELINE_MISMATCH");
  if (patch.baseVersion !== snapshot.projectionVersion
    || patch.projectionVersion !== snapshot.projectionVersion + 1) return fail("CONCEPT_PATCH_VERSION_MISMATCH");
  if (patch.completeThroughRoomSeq < snapshot.completeThroughRoomSeq) {
    return fail("CONCEPT_PATCH_CURSOR_REGRESSION");
  }

  const nodes = new Map<string, ProjectionNode>(snapshot.payload.nodes.map((node) => [node.nodeId, {
    ...node,
    position: { ...node.position },
  } as ProjectionNode]));
  const edges = new Map<string, ProjectionEdge>(snapshot.payload.edges.map((edge) => [edge.edgeId, cloneEdge(edge)]));

  for (const node of patch.nodesAdded) {
    if (nodes.has(node.nodeId)) return fail("CONCEPT_PATCH_NODE_ADD_CONFLICT");
    nodes.set(node.nodeId, { ...node, position: { ...node.position } });
  }
  for (const node of patch.nodesUpdated) {
    if (!nodes.has(node.nodeId)) return fail("CONCEPT_PATCH_NODE_UPDATE_MISSING");
    nodes.set(node.nodeId, { ...node, position: { ...node.position } });
  }
  for (const nodeId of patch.nodesHidden) {
    if (!nodes.delete(nodeId)) return fail("CONCEPT_PATCH_NODE_HIDE_MISSING");
  }

  for (const edge of patch.edgesAdded) {
    if (edges.has(edge.edgeId)) return fail("CONCEPT_PATCH_EDGE_ADD_CONFLICT");
    edges.set(edge.edgeId, cloneEdge(edge));
  }
  for (const edge of patch.edgesUpdated) {
    if (!edges.has(edge.edgeId)) return fail("CONCEPT_PATCH_EDGE_UPDATE_MISSING");
    edges.set(edge.edgeId, cloneEdge(edge));
  }
  for (const edgeId of patch.edgesHidden) {
    if (!edges.delete(edgeId)) return fail("CONCEPT_PATCH_EDGE_HIDE_MISSING");
  }
  for (const position of patch.positionUpdates) {
    const node = nodes.get(position.nodeId);
    if (!node) return fail("CONCEPT_PATCH_POSITION_TARGET_MISSING");
    nodes.set(position.nodeId, { ...node, position: { x: position.x, y: position.y } });
  }
  for (const edge of edges.values()) {
    if (!nodes.has(edge.head) || !nodes.has(edge.tail)) return fail("CONCEPT_PATCH_DANGLING_EDGE");
  }

  try {
    const nextNodes = [...nodes.values()];
    const nextEdges = [...edges.values()];
    return analyticsContract.parseEchoSnapshot({
      ...snapshot,
      analysisEpoch: patch.analysisEpoch,
      algorithmVersion: patch.algorithmVersion,
      parameterHash: patch.parameterHash,
      projectionVersion: patch.projectionVersion,
      baseVersion: patch.baseVersion,
      completeThroughRoomSeq: patch.completeThroughRoomSeq,
      requiresReplay: false,
      evidenceStatus: "active",
      reviewStatus: snapshot.projectionKey === "echo.student_approved"
        ? (nextNodes.length > 0 || nextEdges.length > 0 ? "approved" : "unreviewed")
        : snapshot.reviewStatus,
      warnings: [...patch.warnings],
      payload: {
        nodes: nextNodes,
        edges: nextEdges,
      },
    });
  } catch {
    return fail("CONCEPT_PATCH_RESULT_INVALID");
  }
}
