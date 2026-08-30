/* generated; source is JSON Schema */

export interface AnalysisProjectionEnvelope {
  schemaVersion: 1;
  projectionKey: "echo.teacher_shadow" | "echo.student_approved" | "trace.teacher_bundle" | "trace.student_bundle";
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
  displayStatus: "hidden" | "teacher_shadow" | "student_approved" | "student_aggregate";
  /**
   * @maxItems 64
   */
  warnings: string[];
  payload: {
    [k: string]: unknown;
  };
}
