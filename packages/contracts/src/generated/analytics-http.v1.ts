/* generated; source is JSON Schema */

export type AnalyticsHttpResponse = PatchPage | TimelineResponse | ResyncResponse;
export type ConceptMapSnapshot = Common & {
  payload: {
    nodes: ConceptNode[];
    edges: ConceptEdge[];
  };
  [k: string]: unknown;
};

export interface PatchPage {
  /**
   * @maxItems 200
   */
  patches: ConceptMapPatch[];
}
export interface ConceptMapPatch {
  analysisEpoch: string;
  algorithmVersion: string;
  parameterHash: string;
  projectionVersion: number;
  baseVersion: number;
  completeThroughRoomSeq: number;
  requiresReplay: boolean;
  warnings: string[];
  nodesAdded: ConceptNode[];
  nodesUpdated: ConceptNode[];
  nodesHidden: string[];
  edgesAdded: ConceptEdge[];
  edgesUpdated: ConceptEdge[];
  edgesHidden: string[];
  positionUpdates: PositionUpdate[];
  changeScore: number;
  reasonCodes: string[];
  evidenceRefs: EvidenceRef[];
}
export interface ConceptNode {
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
export interface ConceptEdge {
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
export interface TimelineResponse {
  baseSnapshot: null | ConceptMapSnapshot;
  /**
   * @maxItems 200
   */
  patches: ConceptMapPatch[];
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
export interface ResyncResponse {
  code: "SNAPSHOT_RESYNC_REQUIRED";
  snapshotUrl: string;
}
