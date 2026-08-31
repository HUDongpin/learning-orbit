import type { ValidateFunction } from "ajv";

import analyticsReviewPayloadSchema from "../schemas/analytics-review-room-event-payloads.v1.json" with { type: "json" };
import echoSchema from "../schemas/echo-concept-projection.v1.json" with { type: "json" };
import roomEventSchema from "../schemas/room-event-envelope.v1.json" with { type: "json" };
import exportSchema from "../schemas/teacher-room-export.v1.json" with { type: "json" };
import traceSchema from "../schemas/trace-projection.v1.json" with { type: "json" };
import type { TeacherRoomExport } from "./generated/teacher-room-export.v1.js";
import { analyticsContract } from "./analytics.js";
import { parseCoreRoomEvent, parseRoomEventEnvelope } from "./core-room-event.js";
import { makeSchemaAjv } from "./schema-ajv.js";

type ExportArtifact = TeacherRoomExport["artifacts"][number];
type ArtifactSource = TeacherRoomExport["provenance"]["artifactSources"][number];
type ExportProjection = TeacherRoomExport["projections"][number];
type ProjectionSource = TeacherRoomExport["provenance"]["projectionSources"][number];

const ajv = makeSchemaAjv();
for (const schema of [roomEventSchema, echoSchema, traceSchema, exportSchema, analyticsReviewPayloadSchema]) {
  ajv.addSchema(schema);
}

function validator<T>(id: string): ValidateFunction<T> {
  const found = ajv.getSchema(id);
  if (!found) throw new Error("TEACHER_ROOM_EXPORT_SCHEMA_REGISTRATION_FAILED");
  return found as ValidateFunction<T>;
}

const validateExport = validator<TeacherRoomExport>(exportSchema.$id);
const validateReviewNotice = validator<Record<string, unknown>>(
  `${analyticsReviewPayloadSchema.$id}#/$defs/AnalyticsReviewNoticePayload`,
);
const validateCorrectionNotice = validator<Record<string, unknown>>(
  `${analyticsReviewPayloadSchema.$id}#/$defs/AnalyticsCorrectionNoticePayload`,
);

function invalid(): never {
  throw new Error("INVALID_TEACHER_ROOM_EXPORT");
}

function assertKnownEvent(value: unknown): ReturnType<typeof parseRoomEventEnvelope> {
  const event = parseRoomEventEnvelope(value);
  if (parseCoreRoomEvent(event)) return event;
  if (event.type === "analytics.review.recorded.v1" && validateReviewNotice(event.payload)) return event;
  if (event.type === "analytics.correction.recorded.v1" && validateCorrectionNotice(event.payload)) return event;
  return invalid();
}

function assertArtifactSource(artifact: ExportArtifact, source: ArtifactSource | undefined): void {
  if (!source
    || source.artifactId !== artifact.artifactId
    || source.lineageId !== artifact.lineageId
    || source.roomId !== artifact.roomId
    || source.eventId !== artifact.eventId
    || source.roomSeq !== artifact.roomSeq
    || source.sourceModality !== artifact.sourceModality
    || source.derivation !== artifact.derivation) invalid();
}

function assertProjectionSource(projection: ExportProjection, source: ProjectionSource | undefined): void {
  if (!source
    || source.projectionKey !== projection.projectionKey
    || source.roomId !== projection.roomId
    || source.analysisEpoch !== projection.analysisEpoch
    || source.algorithmVersion !== projection.algorithmVersion
    || source.projectionVersion !== projection.projectionVersion
    || source.completeThroughRoomSeq !== projection.completeThroughRoomSeq
    || source.watermarkEventTime !== projection.watermarkEventTime) invalid();
}

function assertSemantics(value: TeacherRoomExport): void {
  if (value.events.length !== value.throughRoomSeq) invalid();
  const eventIds = new Set<string>();
  const eventsById = new Map<string, ReturnType<typeof parseRoomEventEnvelope>>();
  for (const [index, candidate] of value.events.entries()) {
    const event = assertKnownEvent(candidate);
    if (event.roomId !== value.roomId || event.roomSeq !== index + 1 || eventIds.has(event.eventId)) invalid();
    eventIds.add(event.eventId);
    eventsById.set(event.eventId, event);
  }

  const artifactSources = new Map<string, ArtifactSource>();
  for (const source of value.provenance.artifactSources) {
    if (artifactSources.has(source.artifactId) || source.roomId !== value.roomId
      || source.roomSeq > value.throughRoomSeq) invalid();
    artifactSources.set(source.artifactId, source);
  }
  if (artifactSources.size !== value.artifacts.length) invalid();
  const artifactIds = new Set<string>();
  let previousArtifact: ExportArtifact | undefined;
  for (const artifact of value.artifacts) {
    const sourceEvent = eventsById.get(artifact.eventId);
    const sourceEventTypeIsValid = artifact.derivation === "human_correction"
      ? sourceEvent?.type === "analytics.correction.recorded.v1"
      : sourceEvent?.type === "message.added" || sourceEvent?.type === "message.revised";
    if (artifactIds.has(artifact.artifactId)
      || artifact.roomId !== value.roomId
      || artifact.roomSeq > value.throughRoomSeq
      || !sourceEvent
      || sourceEvent.roomSeq !== artifact.roomSeq
      || !sourceEventTypeIsValid
      || (previousArtifact !== undefined
        && (artifact.roomSeq < previousArtifact.roomSeq
          || (artifact.roomSeq === previousArtifact.roomSeq
            && artifact.artifactId.localeCompare(previousArtifact.artifactId) <= 0)))) invalid();
    artifactIds.add(artifact.artifactId);
    assertArtifactSource(artifact, artifactSources.get(artifact.artifactId));
    previousArtifact = artifact;
  }

  const projectionSources = new Map<string, ProjectionSource>();
  for (const source of value.provenance.projectionSources) {
    if (projectionSources.has(source.projectionKey) || source.roomId !== value.roomId
      || source.completeThroughRoomSeq > value.throughRoomSeq) invalid();
    projectionSources.set(source.projectionKey, source);
  }
  if (projectionSources.size !== value.projections.length) invalid();
  const projectionKeys = new Set<string>();
  for (const projection of value.projections) {
    if (projectionKeys.has(projection.projectionKey)
      || projection.roomId !== value.roomId
      || projection.completeThroughRoomSeq > value.throughRoomSeq) invalid();
    if (projection.projectionKey === "echo.teacher_shadow") {
      analyticsContract.parseTeacherEchoSnapshot(projection);
    } else if (projection.projectionKey === "trace.teacher_bundle") {
      const parsed = analyticsContract.parseTrace(projection);
      if (parsed.projectionKey !== "trace.teacher_bundle") invalid();
    } else {
      invalid();
    }
    projectionKeys.add(projection.projectionKey);
    assertProjectionSource(projection, projectionSources.get(projection.projectionKey));
  }
}

export const teacherRoomExportContract = {
  parse(value: unknown): TeacherRoomExport {
    try {
      if (!validateExport(value)) invalid();
      assertSemantics(value);
      return value;
    } catch {
      return invalid();
    }
  },
  encode(value: unknown): string {
    return JSON.stringify(this.parse(value));
  },
};

export type { TeacherRoomExport } from "./generated/teacher-room-export.v1.js";
