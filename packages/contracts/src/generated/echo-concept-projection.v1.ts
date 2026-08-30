/* generated; source is JSON Schema */

export type EchoConceptProjection = ConceptMapSnapshot | ConceptMapPatch;
export type ConceptMapSnapshot = TeacherConceptMapSnapshot | StudentConceptMapSnapshot;
export type TeacherConceptMapSnapshot = Common & {
  projectionKey: "echo.teacher_shadow";
  displayStatus: "teacher_shadow";
  payload: {
    nodes: TeacherConceptNode[];
    edges: TeacherConceptEdge[];
  };
  [k: string]: unknown;
};
export type StudentConceptMapSnapshot = EmptyStudentConceptMapSnapshot | ApprovedStudentConceptMapSnapshot;
export type EmptyStudentConceptMapSnapshot = Common & {
  projectionKey: "echo.student_approved";
  reviewStatus: "unreviewed";
  displayStatus: "student_approved";
  payload: {
    /**
     * @maxItems 0
     */
    nodes: [];
    /**
     * @maxItems 0
     */
    edges: [];
  };
  [k: string]: unknown;
};
export type ApprovedStudentConceptMapSnapshot =
  ApprovedStudentNodesConceptMapSnapshot | ApprovedStudentEdgesConceptMapSnapshot;
export type ApprovedStudentNodesConceptMapSnapshot = Common & {
  projectionKey: "echo.student_approved";
  reviewStatus: "approved";
  displayStatus: "student_approved";
  payload: {
    /**
     * @minItems 1
     */
    nodes: [StudentConceptNode, ...StudentConceptNode[]];
    edges: StudentConceptEdge[];
  };
  [k: string]: unknown;
};
export type ApprovedStudentEdgesConceptMapSnapshot = Common & {
  projectionKey: "echo.student_approved";
  reviewStatus: "approved";
  displayStatus: "student_approved";
  payload: {
    nodes: StudentConceptNode[];
    /**
     * @minItems 1
     */
    edges: [StudentConceptEdge, ...StudentConceptEdge[]];
  };
  [k: string]: unknown;
};
export type ConceptMapPatch = TeacherConceptMapPatch | StudentConceptMapPatch;

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
export interface StudentConceptNode {
  nodeId: string;
  label: string;
  nodeKind: "concept";
  evidenceStatus:
    "supported" | "challenged" | "uncertain" | "disputed" | "retracted" | "superseded" | "requires_replay";
  reviewStatus: "approved";
  displayStatus: "confirmed" | "provisional" | "disputed" | "inactive";
  position: Position;
}
export interface StudentConceptEdge {
  edgeId: string;
  head: string;
  predicate: string;
  tail: string;
  relationFamily: string;
  evidenceStatus:
    "supported" | "challenged" | "uncertain" | "disputed" | "retracted" | "superseded" | "requires_replay";
  reviewStatus: "approved";
  displayStatus: "confirmed" | "provisional" | "disputed" | "inactive";
}
export interface TeacherConceptMapPatch {
  analysisEpoch: string;
  algorithmVersion: string;
  parameterHash: string;
  projectionVersion: number;
  baseVersion: number;
  completeThroughRoomSeq: number;
  requiresReplay: boolean;
  warnings: string[];
  nodesAdded: TeacherConceptNode[];
  nodesUpdated: TeacherConceptNode[];
  nodesHidden: string[];
  edgesAdded: TeacherConceptEdge[];
  edgesUpdated: TeacherConceptEdge[];
  edgesHidden: string[];
  positionUpdates: PositionUpdate[];
  changeScore: number;
  reasonCodes: string[];
  evidenceRefs: EvidenceRef[];
}
export interface PositionUpdate {
  nodeId: string;
  x: number;
  y: number;
}
export interface StudentConceptMapPatch {
  analysisEpoch: string;
  algorithmVersion: string;
  parameterHash: string;
  projectionVersion: number;
  baseVersion: number;
  completeThroughRoomSeq: number;
  requiresReplay: boolean;
  warnings: string[];
  nodesAdded: StudentConceptNode[];
  nodesUpdated: StudentConceptNode[];
  nodesHidden: string[];
  edgesAdded: StudentConceptEdge[];
  edgesUpdated: StudentConceptEdge[];
  edgesHidden: string[];
  positionUpdates: PositionUpdate[];
  changeScore: number;
  reasonCodes: string[];
}
