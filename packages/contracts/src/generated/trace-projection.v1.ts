/* generated; source is JSON Schema */

export type SnaProjectionBundle = TeacherBundle | StudentBundle;
export type TeacherBundle = Meta & {
  projectionKey: "trace.teacher_bundle";
  displayStatus?: "teacher_shadow";
  payload: {
    windows: {
      recent_10m: TeacherWindow;
      session_45m: TeacherWindow;
    };
    actorMapping: {
      [k: string]: TeacherActorMappingEntry;
    };
  };
  [k: string]: unknown;
};
export type EvidenceRef = {
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
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-zA-Z0-9_-]{1,160}$".
 */
export type TeacherActorMappingEntry =
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
export type StudentBundle = Meta & {
  projectionKey: "trace.student_bundle";
  reviewStatus: "approved";
  displayStatus: "student_aggregate";
  warnings?: StudentWarning[];
  payload: {
    windows: {
      recent_10m: StudentWindow;
      session_45m: StudentWindow;
    };
    interpretation: "此圖呈現系統觀測到的近期互動事件，不等同友情、地位、能力、貢獻價值、學習成績、心理關係或 Agent 因果效果。";
  };
  [k: string]: unknown;
};
export type StudentWarning =
  "small_group_interpretation_warning" | "recent_group_interaction_only" | "requires_replay" | "insufficient_window";

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
  channels: Channels;
  weight: number;
  /**
   * @minItems 1
   */
  evidenceRefs: [EvidenceRef, ...EvidenceRef[]];
}
export interface Channels {
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
  channels: Channels;
  weight: number;
  /**
   * @minItems 1
   */
  evidenceRefs: [EvidenceRef, ...EvidenceRef[]];
}
export interface StudentWindow {
  windowStartEventTime: string;
  windowEndEventTime: string;
  views: {
    observed: StudentView;
    human_only: StudentView;
    lineage_adjusted: StudentView;
  };
}
export interface StudentView {
  nodes: StudentNode[];
  edges: StudentEdge[];
  metrics: Metrics;
  warnings: StudentWarning[];
}
export interface StudentNode {
  nodeId: string;
  label: "探索者 A" | "探索者 B" | "探索者 C" | "探索者 D";
  kind: "learner";
}
export interface StudentEdge {
  sourceNodeId: string;
  targetNodeId: string;
  layer: "communication" | "uptake";
}
