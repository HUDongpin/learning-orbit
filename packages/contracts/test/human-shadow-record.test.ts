import { describe, expect, it } from "vitest";

import { humanShadowRecordContract } from "../src/governance.js";

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

function record(override: Record<string, unknown> = {}) {
  return {
    recordKind: "human_shadow_completed",
    shadowId: "33333333-3333-4333-8333-333333333333",
    roomId: "44444444-4444-4444-8444-444444444444",
    teacherRef: "a".repeat(64),
    rehearsal: false,
    studentsPresent: false,
    startedAt: "2026-09-07T09:00:00.000Z",
    endedAt: "2026-09-07T09:45:00.000Z",
    agentRunsObserved: [RUN_A, RUN_B],
    observations: [
      { agentRunId: RUN_A, outcome: "appropriate", note: "追問證據，沒有直接給答案" },
      { agentRunId: RUN_B, outcome: "blocked", note: "安全政策攔下一則直接答案" },
    ],
    verdict: "ready_for_students",
    ...override,
  };
}

describe("completed teacher shadow record", () => {
  it("accepts a session that was actually conducted", () => {
    const parsed = humanShadowRecordContract.parse(record());
    expect(parsed.verdict).toBe("ready_for_students");
    expect(parsed.agentRunsObserved).toHaveLength(2);
  });

  it("refuses a rehearsal offered as a shadow", () => {
    // A synthetic rehearsal is useful preparation and is not the thing Gate 6
    // asks for.
    expect(() => humanShadowRecordContract.parse(record({ rehearsal: true })))
      .toThrow("SHADOW_WAS_A_REHEARSAL");
  });

  it("refuses a session that had students in it", () => {
    // A shadow exists so that the first session with students is not the first
    // session at all.
    expect(() => humanShadowRecordContract.parse(record({ studentsPresent: true })))
      .toThrow("SHADOW_HAD_STUDENTS_PRESENT");
  });

  it("refuses a session too short to have seen anything", () => {
    expect(() => humanShadowRecordContract.parse(record({ endedAt: "2026-09-07T09:05:00.000Z" })))
      .toThrow("SHADOW_TOO_SHORT");
  });

  it("refuses a verdict covering runs nobody wrote down", () => {
    expect(() => humanShadowRecordContract.parse(record({
      agentRunsObserved: [RUN_A, RUN_B],
      observations: [{ agentRunId: RUN_A, outcome: "appropriate", note: "只看了一次" }],
    }))).toThrow("SHADOW_OBSERVATIONS_INCOMPLETE");
  });

  it("refuses a ready verdict over an observation of harm", () => {
    // The record cannot both report harm and clear the system for students.
    expect(() => humanShadowRecordContract.parse(record({
      observations: [
        { agentRunId: RUN_A, outcome: "harmful", note: "給出了一個學生沒問的結論" },
        { agentRunId: RUN_B, outcome: "blocked", note: "安全政策攔下一則直接答案" },
      ],
    }))).toThrow("SHADOW_VERDICT_CONTRADICTS_OBSERVATIONS");
  });

  it("allows a not-ready verdict to report harm, which is its purpose", () => {
    const parsed = humanShadowRecordContract.parse(record({
      verdict: "not_ready",
      observations: [
        { agentRunId: RUN_A, outcome: "harmful", note: "給出了一個學生沒問的結論" },
        { agentRunId: RUN_B, outcome: "unhelpful", note: "重複了學生已經說過的話" },
      ],
      conditions: ["重新檢視安全政策後再安排一次影隨"],
    }));
    expect(parsed.verdict).toBe("not_ready");
  });

  it("refuses a record that names the teacher instead of a digest", () => {
    expect(() => humanShadowRecordContract.parse(record({ teacherRef: "teacher@school.example" })))
      .toThrow("INVALID_HUMAN_SHADOW_RECORD");
  });

  it("refuses a shadow that observed no runs at all", () => {
    expect(() => humanShadowRecordContract.parse(record({ agentRunsObserved: [], observations: [] })))
      .toThrow("INVALID_HUMAN_SHADOW_RECORD");
  });

  it("refuses an end before its start", () => {
    expect(() => humanShadowRecordContract.parse(record({
      startedAt: "2026-09-07T10:00:00.000Z", endedAt: "2026-09-07T09:00:00.000Z",
    }))).toThrow("INVALID_HUMAN_SHADOW_RECORD");
  });
});
