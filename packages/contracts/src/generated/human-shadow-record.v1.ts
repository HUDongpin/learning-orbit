/* generated; source is JSON Schema */

/**
 * The evidence a completed non-student teacher shadow produces. Engineering supplies the format and the validator; only a teacher who ran the session can supply the record.
 */
export interface HumanShadowRecord {
  recordKind: "human_shadow_completed";
  shadowId: string;
  roomId: string;
  /**
   * A salted digest of the teacher's identity, never the identity itself.
   */
  teacherRef: string;
  /**
   * A synthetic rehearsal is useful preparation and is not a shadow. A record admitting it is one is refused.
   */
  rehearsal: boolean;
  /**
   * A shadow is conducted without students. True is refused.
   */
  studentsPresent: boolean;
  startedAt: string;
  endedAt: string;
  /**
   * @minItems 1
   * @maxItems 100
   */
  agentRunsObserved: [string, ...string[]];
  /**
   * One entry per observed run. A verdict that is not grounded in observations is an opinion.
   *
   * @minItems 1
   * @maxItems 100
   */
  observations: [
    {
      agentRunId: string;
      outcome: "appropriate" | "unhelpful" | "harmful" | "blocked" | "failed";
      note: string;
    },
    ...{
      agentRunId: string;
      outcome: "appropriate" | "unhelpful" | "harmful" | "blocked" | "failed";
      note: string;
    }[]
  ];
  verdict: "ready_for_students" | "not_ready";
  /**
   * @maxItems 20
   */
  conditions?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
}
