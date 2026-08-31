import { describe, expect, it } from "vitest";

import { AnalyticsPolicyError } from "../../src/modules/analytics/analytics-policy.js";
import { projectionDeliveryFailureDecision } from "../../src/modules/realtime/projection-delivery-decision.js";

describe("projection delivery failure mapping", () => {
  it("closes the room socket only when session or room authority is actually lost", () => {
    expect(projectionDeliveryFailureDecision(new AnalyticsPolicyError(401, "AUTH_REQUIRED")))
      .toEqual({ allow: false, closeCode: 4401 });
    expect(projectionDeliveryFailureDecision(new AnalyticsPolicyError(404, "ROOM_NOT_FOUND")))
      .toEqual({ allow: false, closeCode: 4403 });
    expect(projectionDeliveryFailureDecision(new AnalyticsPolicyError(410, "ROOM_DELETION_IN_PROGRESS")))
      .toEqual({ allow: false, closeCode: 4410 });
  });

  it("silently skips projection-only policy failures so chat remains connected", () => {
    for (const error of [
      new AnalyticsPolicyError(404, "PROJECTION_NOT_FOUND"),
      new AnalyticsPolicyError(403, "PROJECTION_FORBIDDEN"),
      new AnalyticsPolicyError(403, "STUDENT_ANALYTICS_NOT_PROMOTED"),
      new AnalyticsPolicyError(410, "RETENTION_POLICY_EXPIRED"),
      new Error("internal policy read failed"),
    ]) {
      expect(projectionDeliveryFailureDecision(error)).toEqual({ allow: false });
    }
  });
});
