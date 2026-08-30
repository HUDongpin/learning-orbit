/* generated; source is JSON Schema */

export type AnalyticsHttpResponse = PatchPage | TimelineResponse | ResyncResponse;
export type PatchPage = TeacherPatchPage | StudentPatchPage;
export type TimelineResponse = TeacherTimelineResponse | StudentTimelineResponse;
export type TeacherConceptMapSnapshot = Common & {
  projectionKey: "echo.teacher_shadow";
  displayStatus: "teacher_shadow";
  payload: {
    nodes: TeacherConceptNode[];
    edges: TeacherConceptEdge[];
  };
  [k: string]: unknown;
};
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

export interface TeacherPatchPage {
  schemaVersion: 1;
  roomId: string;
  projectionKey: "echo.teacher_shadow";
  analysisEpoch: string;
  /**
   * @maxItems 200
   */
  patches: TeacherConceptMapPatch[];
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
export interface PositionUpdate {
  nodeId: string;
  x: number;
  y: number;
}
export interface StudentPatchPage {
  schemaVersion: 1;
  roomId: string;
  projectionKey: "echo.student_approved";
  analysisEpoch: string;
  /**
   * @maxItems 200
   */
  patches: StudentConceptMapPatch[];
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
export interface TeacherTimelineResponse {
  schemaVersion: 1;
  roomId: string;
  projectionKey: "echo.teacher_shadow";
  analysisEpoch: string;
  baseSnapshot: null | TeacherConceptMapSnapshot;
  /**
   * @maxItems 200
   */
  patches: TeacherConceptMapPatch[];
  truncatedBeforeVersion: null | number;
  headVersion: number;
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
export interface StudentTimelineResponse {
  schemaVersion: 1;
  roomId: string;
  projectionKey: "echo.student_approved";
  analysisEpoch: string;
  baseSnapshot:
    | null
    | (
        | EmptyStudentConceptMapSnapshot
        | (ApprovedStudentNodesConceptMapSnapshot | ApprovedStudentEdgesConceptMapSnapshot)
      );
  /**
   * @maxItems 200
   */
  patches: StudentConceptMapPatch[];
  truncatedBeforeVersion: null | number;
  headVersion: number;
}
export interface ResyncResponse {
  code: "SNAPSHOT_RESYNC_REQUIRED";
  snapshotUrl: string;
}
