import type { ValidateFunction } from "ajv";
import artifactSchema from "../schemas/derived-text-artifact.v1.json" with { type: "json" };
import artifactPageSchema from "../schemas/derived-text-artifact-page.v1.json" with { type: "json" };
import envelopeSchema from "../schemas/analysis-projection-envelope.v1.json" with { type: "json" };
import echoSchema from "../schemas/echo-concept-projection.v1.json" with { type: "json" };
import traceSchema from "../schemas/trace-projection.v1.json" with { type: "json" };
import reviewSchema from "../schemas/analytics-review-command.v1.json" with { type: "json" };
import reviewPayloadSchema from "../schemas/analytics-review-room-event-payloads.v1.json" with { type: "json" };
import type { DerivedTextArtifact } from "./generated/derived-text-artifact.v1.js";
import type { DerivedTextArtifactPage } from "./generated/derived-text-artifact-page.v1.js";
import type { AnalysisProjectionEnvelope } from "./generated/analysis-projection-envelope.v1.js";
import type { ConceptMapPatch, ConceptMapSnapshot } from "./generated/echo-concept-projection.v1.js";
import type { SnaProjectionBundle } from "./generated/trace-projection.v1.js";
import { makeSchemaAjv } from "./schema-ajv.js";

const ajv = makeSchemaAjv();
for (const schema of [artifactSchema, artifactPageSchema, envelopeSchema, echoSchema, traceSchema, reviewSchema, reviewPayloadSchema]) {
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
  const edges = (value as { payload?: { edges?: unknown[] } }).payload?.edges;
  const candidates: unknown[] = [refs, ...(Array.isArray(edges) ? edges.flatMap((edge) => {
    const item = edge as { evidenceRefs?: unknown };
    return Array.isArray(item?.evidenceRefs) ? item.evidenceRefs : [];
  }) : [])];
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

const artifact = validator<DerivedTextArtifact>(artifactSchema.$id);
const page = validator<DerivedTextArtifactPage>(artifactPageSchema.$id);
const envelope = validator<AnalysisProjectionEnvelope>(envelopeSchema.$id);
const echoSnapshot = validator<ConceptMapSnapshot>(`${echoSchema.$id}#/$defs/ConceptMapSnapshot`);
const echoPatch = validator<ConceptMapPatch>(`${echoSchema.$id}#/$defs/ConceptMapPatch`);
const trace = validator<SnaProjectionBundle>(traceSchema.$id);
const review = validator(`${reviewSchema.$id}`);

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
  parseEchoSnapshot(value: unknown) { const result = parse(value, echoSnapshot, "INVALID_ECHO_PROJECTION"); assertEchoSpans(result); return result; },
  parseEchoPatch(value: unknown) { const result = parse(value, echoPatch, "INVALID_ECHO_PATCH"); assertEchoSpans(result); return result; },
  parseTrace(value: unknown) { return parse(value, trace, "INVALID_TRACE_PROJECTION"); },
  parseReview(value: unknown) { const result = parse(value, review, "INVALID_ANALYTICS_REVIEW_COMMAND"); assertReviewSemantics(result); return result; },
  encodeArtifact(value: unknown) { return JSON.stringify(this.parseArtifact(value)); },
  encodeArtifactPage(value: unknown) { return JSON.stringify(this.parseArtifactPage(value)); },
  encodeEnvelope(value: unknown) { return JSON.stringify(this.parseEnvelope(value)); },
};

export type { DerivedTextArtifact, DerivedTextArtifactPage, AnalysisProjectionEnvelope, ConceptMapPatch, ConceptMapSnapshot, SnaProjectionBundle };
