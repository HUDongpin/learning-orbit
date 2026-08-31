import type { ValidateFunction } from "ajv";
import artifactSchema from "../schemas/derived-text-artifact.v1.json" with { type: "json" };
import artifactPageSchema from "../schemas/derived-text-artifact-page.v1.json" with { type: "json" };
import envelopeSchema from "../schemas/analysis-projection-envelope.v1.json" with { type: "json" };
import echoSchema from "../schemas/echo-concept-projection.v1.json" with { type: "json" };
import traceSchema from "../schemas/trace-projection.v1.json" with { type: "json" };
import analyticsHttpSchema from "../schemas/analytics-http.v1.json" with { type: "json" };
import reviewSchema from "../schemas/analytics-review-command.v1.json" with { type: "json" };
import reviewPayloadSchema from "../schemas/analytics-review-room-event-payloads.v1.json" with { type: "json" };
import type { DerivedTextArtifact } from "./generated/derived-text-artifact.v1.js";
import type { DerivedTextArtifactPage } from "./generated/derived-text-artifact-page.v1.js";
import type { AnalysisProjectionEnvelope } from "./generated/analysis-projection-envelope.v1.js";
import type {
  ConceptMapPatch,
  ConceptMapSnapshot,
  StudentConceptMapPatch,
  StudentConceptMapSnapshot,
  TeacherConceptMapPatch,
  TeacherConceptMapSnapshot,
} from "./generated/echo-concept-projection.v1.js";
import type { SnaProjectionBundle } from "./generated/trace-projection.v1.js";
import type {
  PatchPage,
  ResyncResponse,
  StudentPatchPage,
  StudentTimelineResponse,
  TeacherPatchPage,
  TeacherTimelineResponse,
  TimelineResponse,
} from "./generated/analytics-http.v1.js";
import type { AnalyticsReviewCommand } from "./generated/analytics-review-command.v1.js";
import { makeSchemaAjv } from "./schema-ajv.js";

const ajv = makeSchemaAjv();
for (const schema of [artifactSchema, artifactPageSchema, envelopeSchema, echoSchema, traceSchema, analyticsHttpSchema, reviewSchema, reviewPayloadSchema]) {
  ajv.addSchema(schema);
}

/** The closed, content-free payload catalog used by server composition. */
export const analyticsReviewRoomEventPayloadSchema = reviewPayloadSchema;

function validator<T>(id: string): ValidateFunction<T> {
  const found = ajv.getSchema(id);
  if (!found) throw new Error(`ANALYTICS_SCHEMA_NOT_REGISTERED:${id}`);
  return found as ValidateFunction<T>;
}

function parse<T>(value: unknown, validate: ValidateFunction<T>, code: string): T {
  if (!validate(value)) throw new Error(code);
  return value;
}

function assertEchoSpans(value: ConceptMapSnapshot | ConceptMapPatch): void {
  const refs = (value as { evidenceRefs?: unknown }).evidenceRefs;
  const snapshotEdges = (value as { payload?: { edges?: unknown[] } }).payload?.edges;
  const patchEdges = [
    ...((value as { edgesAdded?: unknown[] }).edgesAdded ?? []),
    ...((value as { edgesUpdated?: unknown[] }).edgesUpdated ?? []),
  ];
  const edges = [...(Array.isArray(snapshotEdges) ? snapshotEdges : []), ...patchEdges];
  const candidates: unknown[] = [refs, ...edges.map((edge) => {
    const item = edge as { evidenceRefs?: unknown };
    return item?.evidenceRefs;
  })];
  for (const group of candidates) {
    if (!Array.isArray(group)) continue;
    for (const ref of group) {
      const item = ref as { start?: unknown; end?: unknown };
      if (typeof item.start !== "number" || typeof item.end !== "number" || item.end <= item.start) {
        throw new Error("INVALID_ECHO_EVIDENCE_SPAN");
      }
    }
  }
}

function assertEchoSnapshotSemantics(value: ConceptMapSnapshot): void {
  if (value.baseVersion !== value.projectionVersion - 1
    || value.requiresReplay !== (value.evidenceStatus === "requires_replay")) {
    throw new Error("INVALID_ECHO_PROJECTION");
  }
  if (value.projectionKey === "echo.teacher_shadow") {
    if (value.displayStatus !== "teacher_shadow") throw new Error("INVALID_ECHO_PROJECTION");
  } else {
    const hasApprovedContent = value.payload.nodes.length > 0 || value.payload.edges.length > 0;
    if (value.displayStatus !== "student_approved"
      || value.reviewStatus !== (hasApprovedContent ? "approved" : "unreviewed")) {
      throw new Error("INVALID_ECHO_PROJECTION");
    }
  }
  const nodeIds = new Set<string>();
  for (const node of value.payload.nodes) {
    if (nodeIds.has(node.nodeId)
      || (value.projectionKey === "echo.student_approved" && node.reviewStatus !== "approved")) {
      throw new Error("INVALID_ECHO_PROJECTION");
    }
    nodeIds.add(node.nodeId);
  }
  const edgeIds = new Set<string>();
  for (const edge of value.payload.edges) {
    if (edgeIds.has(edge.edgeId) || !nodeIds.has(edge.head) || !nodeIds.has(edge.tail)
      || (value.projectionKey === "echo.student_approved" && edge.reviewStatus !== "approved")) {
      throw new Error("INVALID_ECHO_PROJECTION");
    }
    edgeIds.add(edge.edgeId);
  }
}

function assertEchoPatchSemantics(value: ConceptMapPatch, code = "INVALID_ECHO_PATCH"): void {
  if (value.projectionVersion !== value.baseVersion + 1) throw new Error(code);
  const groups: readonly (readonly string[])[] = [
    value.nodesAdded.map(({ nodeId }) => nodeId),
    value.nodesUpdated.map(({ nodeId }) => nodeId),
    value.nodesHidden,
  ];
  const nodeMutations = groups.flat();
  if (new Set(nodeMutations).size !== nodeMutations.length) throw new Error(code);
  const edgeMutations = [
    ...value.edgesAdded.map(({ edgeId }) => edgeId),
    ...value.edgesUpdated.map(({ edgeId }) => edgeId),
    ...value.edgesHidden,
  ];
  if (new Set(edgeMutations).size !== edgeMutations.length
    || new Set(value.positionUpdates.map(({ nodeId }) => nodeId)).size !== value.positionUpdates.length) {
    throw new Error(code);
  }
}

function assertTraceSemantics(value: SnaProjectionBundle): void {
  if (value.baseVersion !== value.projectionVersion - 1
    || value.requiresReplay !== (value.evidenceStatus === "requires_replay")) {
    throw new Error("INVALID_TRACE_PROJECTION");
  }
  const windows = value.payload.windows;
  const recent = windows.recent_10m;
  const session = windows.session_45m;
  const recentStart = Date.parse(recent.windowStartEventTime);
  const recentEnd = Date.parse(recent.windowEndEventTime);
  const sessionStart = Date.parse(session.windowStartEventTime);
  const sessionEnd = Date.parse(session.windowEndEventTime);
  const watermark = Date.parse(value.watermarkEventTime);
  const teacherActorMapping = value.projectionKey === "trace.teacher_bundle"
    ? value.payload.actorMapping
    : undefined;
  if (![recentStart, recentEnd, sessionStart, sessionEnd, watermark].every(Number.isFinite)
    || recentStart > recentEnd || sessionStart > sessionEnd
    || recentEnd !== sessionEnd
    || recentEnd - recentStart > 10 * 60_000
    || sessionEnd - sessionStart > 45 * 60_000
    || recentEnd > watermark) {
    throw new Error("INVALID_TRACE_PROJECTION");
  }
  for (const [viewName, candidate] of [...Object.entries(recent.views), ...Object.entries(session.views)]) {
    const view = candidate as {
      nodes: Array<{ nodeId: string; label?: string; kind?: string }>;
      edges: Array<{
        edgeId?: string;
        sourceId?: string;
        targetId?: string;
        sourceNodeId?: string;
        targetNodeId?: string;
        layer: string;
        evidenceRefs?: Array<{ basis: string; start: number | null; end: number | null }>;
      }>;
    };
    const nodeIds = view.nodes.map(({ nodeId }) => nodeId);
    if (new Set(nodeIds).size !== nodeIds.length) throw new Error("INVALID_TRACE_PROJECTION");
    if (teacherActorMapping && view.nodes.some((node) => {
      const mapping = teacherActorMapping[node.nodeId];
      return !mapping || node.label !== mapping.pseudonym || node.kind !== mapping.kind;
    })) {
      throw new Error("INVALID_TRACE_PROJECTION");
    }
    const allowed = new Set(nodeIds);
    const edgeIdentities = new Set<string>();
    for (const edge of view.edges) {
      const sourceId = edge.sourceNodeId ?? edge.sourceId;
      const targetId = edge.targetNodeId ?? edge.targetId;
      if (!sourceId || !targetId) throw new Error("INVALID_TRACE_PROJECTION");
      const identity = edge.edgeId ?? `${sourceId}\0${targetId}\0${edge.layer}`;
      if (!allowed.has(sourceId) || !allowed.has(targetId) || edgeIdentities.has(identity)
        || (viewName === "lineage_adjusted" && edge.layer !== "uptake")) {
        throw new Error("INVALID_TRACE_PROJECTION");
      }
      edgeIdentities.add(identity);
      if (edge.evidenceRefs) {
        for (const ref of edge.evidenceRefs) {
          if (ref.basis === "text_span"
            && (ref.start === null || ref.end === null || ref.end <= ref.start)) {
            throw new Error("INVALID_TRACE_PROJECTION");
          }
        }
      }
    }
  }
}

const artifact = validator<DerivedTextArtifact>(artifactSchema.$id);
const page = validator<DerivedTextArtifactPage>(artifactPageSchema.$id);
const envelope = validator<AnalysisProjectionEnvelope>(envelopeSchema.$id);
const echoSnapshot = validator<ConceptMapSnapshot>(`${echoSchema.$id}#/$defs/ConceptMapSnapshot`);
const teacherEchoSnapshot = validator<TeacherConceptMapSnapshot>(`${echoSchema.$id}#/$defs/TeacherConceptMapSnapshot`);
const studentEchoSnapshot = validator<StudentConceptMapSnapshot>(`${echoSchema.$id}#/$defs/StudentConceptMapSnapshot`);
const echoPatch = validator<ConceptMapPatch>(`${echoSchema.$id}#/$defs/ConceptMapPatch`);
const teacherEchoPatch = validator<TeacherConceptMapPatch>(`${echoSchema.$id}#/$defs/TeacherConceptMapPatch`);
const studentEchoPatch = validator<StudentConceptMapPatch>(`${echoSchema.$id}#/$defs/StudentConceptMapPatch`);
const trace = validator<SnaProjectionBundle>(traceSchema.$id);
const patchPage = validator<PatchPage>(`${analyticsHttpSchema.$id}#/$defs/PatchPage`);
const teacherPatchPage = validator<TeacherPatchPage>(`${analyticsHttpSchema.$id}#/$defs/TeacherPatchPage`);
const studentPatchPage = validator<StudentPatchPage>(`${analyticsHttpSchema.$id}#/$defs/StudentPatchPage`);
const timeline = validator<TimelineResponse>(`${analyticsHttpSchema.$id}#/$defs/TimelineResponse`);
const teacherTimeline = validator<TeacherTimelineResponse>(`${analyticsHttpSchema.$id}#/$defs/TeacherTimelineResponse`);
const studentTimeline = validator<StudentTimelineResponse>(`${analyticsHttpSchema.$id}#/$defs/StudentTimelineResponse`);
const resync = validator<ResyncResponse>(`${analyticsHttpSchema.$id}#/$defs/ResyncResponse`);
const review = validator<AnalyticsReviewCommand>(`${reviewSchema.$id}`);

function assertPatchChain(patches: readonly ConceptMapPatch[], code: string): void {
  let previous: ConceptMapPatch | undefined;
  for (const patch of patches) {
    assertEchoSpans(patch);
    assertEchoPatchSemantics(patch, code);
    if (patch.projectionVersion !== patch.baseVersion + 1
      || (previous && (patch.baseVersion !== previous.projectionVersion
        || patch.analysisEpoch !== previous.analysisEpoch
        || patch.algorithmVersion !== previous.algorithmVersion
        || patch.parameterHash !== previous.parameterHash
        || patch.completeThroughRoomSeq < previous.completeThroughRoomSeq))) {
      throw new Error(code);
    }
    previous = patch;
  }
}

function assertPatchPageSemantics(value: PatchPage, code: string): void {
  assertPatchChain(value.patches, code);
  if (value.patches.some((patch) => patch.analysisEpoch !== value.analysisEpoch)) {
    throw new Error(code);
  }
}

function assertTimelineSemantics(value: TimelineResponse): void {
  assertPatchChain(value.patches, "INVALID_ANALYTICS_TIMELINE");
  if (value.patches.some((patch) => patch.analysisEpoch !== value.analysisEpoch)
    || (value.baseSnapshot && (value.baseSnapshot.roomId !== value.roomId
      || value.baseSnapshot.projectionKey !== value.projectionKey
      || value.baseSnapshot.analysisEpoch !== value.analysisEpoch))) {
    throw new Error("INVALID_ANALYTICS_TIMELINE");
  }
  const first = value.patches[0];
  const last = value.patches.at(-1);
  if (!first || !last) {
    if (value.baseSnapshot !== null || value.truncatedBeforeVersion !== null || value.headVersion !== 0) {
      throw new Error("INVALID_ANALYTICS_TIMELINE");
    }
    return;
  }
  const expectedBaseVersion = value.baseSnapshot?.projectionVersion ?? 0;
  if (first.baseVersion !== expectedBaseVersion || last.projectionVersion !== value.headVersion) {
    throw new Error("INVALID_ANALYTICS_TIMELINE");
  }
  if (value.baseSnapshot) {
    assertEchoSpans(value.baseSnapshot);
    assertEchoSnapshotSemantics(value.baseSnapshot);
    if (value.truncatedBeforeVersion !== value.baseSnapshot.projectionVersion
      || value.baseSnapshot.analysisEpoch !== first.analysisEpoch
      || value.baseSnapshot.algorithmVersion !== first.algorithmVersion
      || value.baseSnapshot.parameterHash !== first.parameterHash
      || value.baseSnapshot.completeThroughRoomSeq > first.completeThroughRoomSeq) {
      throw new Error("INVALID_ANALYTICS_TIMELINE");
    }
  } else if (value.truncatedBeforeVersion !== null) {
    throw new Error("INVALID_ANALYTICS_TIMELINE");
  }
}

function assertReviewSemantics(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, any>;
  if (item.correctionKind === "replace_evidence_span") {
    for (const key of ["target", "replacement"]) {
      const ref = item[key];
      if (!ref || typeof ref.start !== "number" || typeof ref.end !== "number" || ref.end <= ref.start) {
        throw new Error("INVALID_ANALYTICS_REVIEW_COMMAND");
      }
    }
  }
  if (item.correctionKind === "merge_alias" && item.targetCanonicalNodeId === item.replacement?.aliasNodeId) {
    throw new Error("INVALID_ANALYTICS_REVIEW_COMMAND");
  }
  if (item.correctionKind === "split_alias"
    && (item.targetCanonicalNodeId === item.replacement?.aliasNodeId
      || item.targetCanonicalNodeId === item.replacement?.newCanonicalNodeId
      || item.replacement?.aliasNodeId === item.replacement?.newCanonicalNodeId)) {
    throw new Error("INVALID_ANALYTICS_REVIEW_COMMAND");
  }
}

export const analyticsContract = {
  parseArtifact(value: unknown) { return parse(value, artifact, "INVALID_DERIVED_TEXT_ARTIFACT"); },
  parseArtifactPage(value: unknown) { return parse(value, page, "INVALID_DERIVED_TEXT_ARTIFACT_PAGE"); },
  parseEnvelope(value: unknown) { return parse(value, envelope, "INVALID_ANALYSIS_PROJECTION_ENVELOPE"); },
  parseEchoSnapshot(value: unknown) { const result = parse(value, echoSnapshot, "INVALID_ECHO_PROJECTION"); assertEchoSpans(result); assertEchoSnapshotSemantics(result); return result; },
  parseTeacherEchoSnapshot(value: unknown) { const result = parse(value, teacherEchoSnapshot, "INVALID_TEACHER_ECHO_PROJECTION"); assertEchoSpans(result); assertEchoSnapshotSemantics(result); return result; },
  parseStudentEchoSnapshot(value: unknown) { const result = parse(value, studentEchoSnapshot, "INVALID_STUDENT_ECHO_PROJECTION"); assertEchoSpans(result); assertEchoSnapshotSemantics(result); return result; },
  parseEchoPatch(value: unknown) { const result = parse(value, echoPatch, "INVALID_ECHO_PATCH"); assertEchoSpans(result); assertEchoPatchSemantics(result); return result; },
  parseTeacherEchoPatch(value: unknown) { const result = parse(value, teacherEchoPatch, "INVALID_TEACHER_ECHO_PATCH"); assertEchoSpans(result); assertEchoPatchSemantics(result); return result; },
  parseStudentEchoPatch(value: unknown) { const result = parse(value, studentEchoPatch, "INVALID_STUDENT_ECHO_PATCH"); assertEchoSpans(result); assertEchoPatchSemantics(result); return result; },
  parseTrace(value: unknown) { const result = parse(value, trace, "INVALID_TRACE_PROJECTION"); assertTraceSemantics(result); return result; },
  parseReview(value: unknown) { const result = parse(value, review, "INVALID_ANALYTICS_REVIEW_COMMAND"); assertReviewSemantics(result); return result; },
  encodeArtifact(value: unknown) { return JSON.stringify(this.parseArtifact(value)); },
  encodeArtifactPage(value: unknown) { return JSON.stringify(this.parseArtifactPage(value)); },
  encodeEnvelope(value: unknown) { return JSON.stringify(this.parseEnvelope(value)); },
  encodeEchoSnapshot(value: unknown) { return JSON.stringify(this.parseEchoSnapshot(value)); },
  encodeEchoPatch(value: unknown) { return JSON.stringify(this.parseEchoPatch(value)); },
  encodeTrace(value: unknown) { return JSON.stringify(this.parseTrace(value)); },
};

export const analyticsHttpContract = {
  parsePatchPage(value: unknown) {
    const result = parse(value, patchPage, "INVALID_ANALYTICS_PATCH_PAGE");
    assertPatchPageSemantics(result, "INVALID_ANALYTICS_PATCH_PAGE");
    return result;
  },
  parseTeacherPatchPage(value: unknown) {
    const result = parse(value, teacherPatchPage, "INVALID_TEACHER_ANALYTICS_PATCH_PAGE");
    assertPatchPageSemantics(result, "INVALID_TEACHER_ANALYTICS_PATCH_PAGE");
    return result;
  },
  parseStudentPatchPage(value: unknown) {
    const result = parse(value, studentPatchPage, "INVALID_STUDENT_ANALYTICS_PATCH_PAGE");
    assertPatchPageSemantics(result, "INVALID_STUDENT_ANALYTICS_PATCH_PAGE");
    return result;
  },
  parseTimeline(value: unknown) {
    const result = parse(value, timeline, "INVALID_ANALYTICS_TIMELINE");
    assertTimelineSemantics(result);
    return result;
  },
  parseTeacherTimeline(value: unknown) {
    const result = parse(value, teacherTimeline, "INVALID_TEACHER_ANALYTICS_TIMELINE");
    assertTimelineSemantics(result);
    return result;
  },
  parseStudentTimeline(value: unknown) {
    const result = parse(value, studentTimeline, "INVALID_STUDENT_ANALYTICS_TIMELINE");
    assertTimelineSemantics(result);
    return result;
  },
  parseResync(value: unknown) { return parse(value, resync, "INVALID_ANALYTICS_RESYNC"); },
  encodePatchPage(value: unknown) { return JSON.stringify(this.parsePatchPage(value)); },
  encodeTimeline(value: unknown) { return JSON.stringify(this.parseTimeline(value)); },
  encodeResync(value: unknown) { return JSON.stringify(this.parseResync(value)); },
};

export type {
  DerivedTextArtifact, DerivedTextArtifactPage, AnalysisProjectionEnvelope,
  ConceptMapPatch, ConceptMapSnapshot,
  StudentConceptMapPatch, StudentConceptMapSnapshot,
  TeacherConceptMapPatch, TeacherConceptMapSnapshot,
  SnaProjectionBundle,
  PatchPage as AnalyticsPatchPage,
  StudentPatchPage as StudentAnalyticsPatchPage,
  TeacherPatchPage as TeacherAnalyticsPatchPage,
  TimelineResponse as AnalyticsTimelineResponse,
  StudentTimelineResponse as StudentAnalyticsTimelineResponse,
  TeacherTimelineResponse as TeacherAnalyticsTimelineResponse,
  ResyncResponse as AnalyticsResyncResponse,
  AnalyticsReviewCommand,
};
