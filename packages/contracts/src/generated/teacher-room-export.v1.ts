/* generated; source is JSON Schema */

export type RoomEventEnvelope = {
  eventId: string;
  schemaVersion: 1;
  roomId: string;
  roomSeq: number;
  type: string;
  actorId: string;
  actorKind: "human" | "agent" | "system";
  actorRole: "teacher" | "student" | "socratic_facilitator" | "room_clock" | "system_worker";
  revision: number;
  operation: "add" | "revise" | "retract";
  eventTime: string;
  ingestTime: string;
  causationId: string;
  correlationId: string;
  payload: {
    [k: string]: unknown;
  };
} & (
  | {
      actorKind: "human";
      actorRole: "teacher" | "student";
      [k: string]: unknown;
    }
  | {
      actorKind: "agent";
      actorRole: "socratic_facilitator";
      [k: string]: unknown;
    }
  | {
      actorKind: "system";
      actorRole: "room_clock" | "system_worker";
      [k: string]: unknown;
    }
);
/**
 * This interface was referenced by `TeacherRoomExport`'s JSON-Schema
 * via the `definition` "TeacherExportProjection".
 */
export type TeacherExportProjection = TeacherConceptMapSnapshot | TeacherBundle;
export type TeacherConceptMapSnapshot = Common & {
  projectionKey: "echo.teacher_shadow";
  displayStatus: "teacher_shadow";
  payload: {
    nodes: TeacherConceptNode[];
    edges: TeacherConceptEdge[];
  };
  [k: string]: unknown;
};
export type TeacherBundle = Meta & {
  projectionKey: "trace.teacher_bundle";
  displayStatus?: "teacher_shadow";
  payload: {
    windows: {
      recent_10m: TeacherWindow;
      session_45m: TeacherWindow;
    };
    actorMapping: {
      /**
       * This interface was referenced by `undefined`'s JSON-Schema definition
       * via the `patternProperty` "^[a-zA-Z0-9_-]{1,160}$".
       */
      [k: string]:
        | {
            actorId: string;
            pseudonym: "探索者 A" | "探索者 B" | "探索者 C" | "探索者 D";
            kind: "learner";
          }
        | {
            actorId: string;
            pseudonym: "Nova Agent";
            kind: "agent";
          }
        | {
            roomId: string;
            pseudonym: "共學聊天室";
            kind: "room";
          };
    };
  };
  [k: string]: unknown;
};
export type EvidenceRef1 = {
  [k: string]: unknown;
} & {
  [k: string]: unknown;
} & {
  eventId: string;
  start: number | null;
  end: number | null;
  basis: "text_span" | "event_metadata";
} & {
  eventId: string;
  start: number | null;
  end: number | null;
  basis: "text_span" | "event_metadata";
} & {
  eventId: string;
  start: number | null;
  end: number | null;
  basis: "text_span" | "event_metadata";
} & {
  eventId: string;
  start: number | null;
  end: number | null;
  basis: "text_span" | "event_metadata";
};
/**
 * This interface was referenced by `TeacherRoomExport`'s JSON-Schema
 * via the `definition` "ArtifactProvenance".
 */
export type ArtifactProvenance = {
  [k: string]: unknown;
} & {
  artifactId: string;
  lineageId: string;
  roomId: string;
  eventId: string;
  roomSeq: number;
  sourceMediaId: string | null;
  sourceModality: "text" | "audio" | "image";
  derivation: "direct" | "asr" | "ocr" | "image_description" | "human_correction";
  supersedesArtifactId: string | null;
};

export interface TeacherRoomExport {
  schemaVersion: 1;
  exportKind: "teacher_room";
  roomId: string;
  throughRoomSeq: number;
  /**
   * @maxItems 10000
   */
  events: RoomEventEnvelope[];
  /**
   * @maxItems 10000
   */
  artifacts: TeacherExportArtifact[];
  /**
   * @maxItems 2
   */
  projections: [] | [TeacherExportProjection] | [TeacherExportProjection, TeacherExportProjection];
  provenance: TeacherExportProvenance;
}
/**
 * This interface was referenced by `TeacherRoomExport`'s JSON-Schema
 * via the `definition` "TeacherExportArtifact".
 */
export interface TeacherExportArtifact {
  artifactId: string;
  lineageId: string;
  roomId: string;
  eventId: string;
  roomSeq: number;
  sourceModality: "text" | "audio" | "image";
  derivation: "direct" | "asr" | "ocr" | "image_description" | "human_correction";
  text: string;
  languageTag: string;
  reviewStatus: "approved" | "corrected";
  createdAt: string;
}
export interface Common {
  schemaVersion: 1;
  projectionKey: "echo.teacher_shadow" | "echo.student_approved";
  roomId: string;
  analysisEpoch: string;
  algorithmVersion: string;
  parameterHash: string;
  projectionVersion: number;
  baseVersion: number;
  completeThroughRoomSeq: number;
  watermarkEventTime: string;
  requiresReplay: boolean;
  evidenceStatus: "active" | "retracted" | "superseded" | "requires_replay";
  reviewStatus: "unreviewed" | "approved" | "rejected" | "corrected";
  displayStatus: "hidden" | "teacher_shadow" | "student_approved";
  warnings: string[];
  [k: string]: unknown;
}
export interface TeacherConceptNode {
  nodeId: string;
  label: string;
  nodeKind: "concept";
  evidenceStatus:
    "supported" | "challenged" | "uncertain" | "disputed" | "retracted" | "superseded" | "requires_replay";
  reviewStatus: "unreviewed" | "approved" | "rejected" | "corrected";
  displayStatus: "confirmed" | "provisional" | "disputed" | "inactive";
  position: Position;
}
export interface Position {
  x: number;
  y: number;
}
export interface TeacherConceptEdge {
  edgeId: string;
  head: string;
  predicate: string;
  tail: string;
  relationFamily: string;
  evidenceStatus:
    "supported" | "challenged" | "uncertain" | "disputed" | "retracted" | "superseded" | "requires_replay";
  reviewStatus: "unreviewed" | "approved" | "rejected" | "corrected";
  displayStatus: "confirmed" | "provisional" | "disputed" | "inactive";
  channels: Channels;
  activityScore: number;
  /**
   * @minItems 1
   */
  evidenceRefs: [EvidenceRef, ...EvidenceRef[]];
}
export interface Channels {
  support: number;
  challenge: number;
  uncertain: number;
  question: number;
}
export interface EvidenceRef {
  eventId: string;
  start: number;
  end: number;
}
export interface Meta {
  schemaVersion: 1;
  roomId: string;
  analysisEpoch: string;
  algorithmVersion: string;
  parameterHash: string;
  projectionVersion: number;
  baseVersion: number;
  completeThroughRoomSeq: number;
  watermarkEventTime: string;
  requiresReplay: boolean;
  evidenceStatus: "active" | "retracted" | "superseded" | "requires_replay";
  reviewStatus: "unreviewed" | "approved" | "rejected" | "corrected";
  displayStatus: "hidden" | "teacher_shadow" | "student_aggregate";
  warnings: string[];
  [k: string]: unknown;
}
export interface TeacherWindow {
  windowStartEventTime: string;
  windowEndEventTime: string;
  views: {
    observed: TeacherView;
    human_only: HumanView;
    lineage_adjusted: HumanView;
  };
}
export interface TeacherView {
  nodes: TeacherNode[];
  edges: TeacherEdge[];
  metrics: Metrics;
  warnings: string[];
}
export interface TeacherNode {
  nodeId: string;
  label: "探索者 A" | "探索者 B" | "探索者 C" | "探索者 D" | "Nova Agent" | "共學聊天室";
  kind: "learner" | "agent" | "room";
}
export interface TeacherEdge {
  edgeId: string;
  sourceId: string;
  targetId: string;
  layer: "communication" | "uptake" | "stance" | "coordination" | "facilitation";
  channels: Channels1;
  weight: number;
  /**
   * @minItems 1
   */
  evidenceRefs: [EvidenceRef1, ...EvidenceRef1[]];
}
export interface Channels1 {
  positive: number;
  challenge: number;
  uncertain: number;
}
export interface Metrics {
  participationBalance: number;
  reciprocity: number;
  agentShare: number;
  semanticCoverage: number;
}
export interface HumanView {
  nodes: HumanNode[];
  edges: HumanEdge[];
  metrics: Metrics;
  warnings: string[];
}
export interface HumanNode {
  nodeId: string;
  label: "探索者 A" | "探索者 B" | "探索者 C" | "探索者 D";
  kind: "learner";
}
export interface HumanEdge {
  edgeId: string;
  sourceId: string;
  targetId: string;
  layer: "communication" | "uptake" | "stance" | "coordination";
  channels: Channels1;
  weight: number;
  /**
   * @minItems 1
   */
  evidenceRefs: [EvidenceRef1, ...EvidenceRef1[]];
}
/**
 * This interface was referenced by `TeacherRoomExport`'s JSON-Schema
 * via the `definition` "TeacherExportProvenance".
 */
export interface TeacherExportProvenance {
  /**
   * @maxItems 10000
   */
  artifactSources: ArtifactProvenance[];
  /**
   * @maxItems 2
   */
  projectionSources: [] | [ProjectionProvenance] | [ProjectionProvenance, ProjectionProvenance];
}
/**
 * This interface was referenced by `TeacherRoomExport`'s JSON-Schema
 * via the `definition` "ProjectionProvenance".
 */
export interface ProjectionProvenance {
  projectionKey: "echo.teacher_shadow" | "trace.teacher_bundle";
  roomId: string;
  analysisEpoch: string;
  algorithmVersion: string;
  projectionVersion: number;
  completeThroughRoomSeq: number;
  watermarkEventTime: string;
}
