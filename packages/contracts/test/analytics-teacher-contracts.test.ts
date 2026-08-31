import { describe, expect, it } from "vitest";

import {
  analyticsTeacherHttpContract,
  apiErrorContract,
} from "../src/index.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const EPOCH = "00000000-0000-4000-8000-000000000011";
const REVIEW_ID = "00000000-0000-4000-8000-000000000012";
const REPLAY_ID = "00000000-0000-4000-8000-000000000013";
const accepted = {
  schemaVersion: 1,
  reviewEventId: REVIEW_ID,
  changeKind: "review",
  replayJobId: REPLAY_ID,
} as const;
const command = {
  targetType: "derived_text",
  targetId: "00000000-0000-4000-8000-000000000014",
  decision: "approve",
  rationale: "證據來源與文字一致。",
  expectedAnalysisEpoch: EPOCH,
  expectedProjectionVersion: 1,
} as const;

describe("teacher analytics HTTP contracts", () => {
  it("parses a closed review acceptance without exposing command content", () => {
    expect(analyticsTeacherHttpContract.parseAccepted(accepted)).toEqual(accepted);
    expect(() => analyticsTeacherHttpContract.parseAccepted({ ...accepted, rationale: "leak" }))
      .toThrow("INVALID_ANALYTICS_REVIEW_ACCEPTED");
  });

  it("correlates review detail changeKind with the generated command union", () => {
    const detail = {
      schemaVersion: 1,
      reviewEventId: REVIEW_ID,
      roomId: ROOM_ID,
      changeKind: "review",
      payload: command,
      createdAt: "2026-08-31T01:00:00.000Z",
    } as const;
    expect(analyticsTeacherHttpContract.parseDetail(detail)).toEqual(detail);
    expect(() => analyticsTeacherHttpContract.parseDetail({ ...detail, changeKind: "correction" }))
      .toThrow("INVALID_ANALYTICS_REVIEW_DETAIL");
    expect(() => analyticsTeacherHttpContract.parseDetail({
      ...detail,
      reviewerTeacherId: "00000000-0000-4000-8000-000000000099",
    })).toThrow("INVALID_ANALYTICS_REVIEW_DETAIL");
  });

  it("keeps teacher analytics and governance failures inside generated ApiError", () => {
    for (const code of [
      "INVALID_ANALYTICS_REVIEW_COMMAND",
      "ANALYTICS_VERSION_CONFLICT",
      "ANALYTICS_TARGET_NOT_FOUND",
      "ANALYTICS_REVIEW_NOT_FOUND",
      "DELETION_IN_PROGRESS",
      "DELETION_STATUS_CORRUPT",
      "INVALID_DELETE_REQUEST",
      "INVALID_EXPORT_FORMAT",
      "EXPORT_UNAVAILABLE",
    ] as const) expect(apiErrorContract.parse({ code })).toEqual({ code });
  });
});
