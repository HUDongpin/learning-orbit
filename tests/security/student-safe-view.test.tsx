import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import React from "react";

import {
  interpretationMatchesClaimCeiling,
  TRACE_STUDENT_INTERPRETATION_ZH_HANT,
} from "../../apps/web/src/lib/analytics/display-labels";
import { TracePanel } from "../../apps/web/src/lib/analytics/trace-panel";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const EPOCH = "33333333-3333-4333-8333-333333333333";

const WINDOW = {
  windowStartEventTime: "2026-08-30T08:00:00.000Z",
  windowEndEventTime: "2026-08-30T08:10:00.000Z",
  views: {
    observed: {
      nodes: [{ nodeId: "44444444-4444-4444-8444-444444444444", label: "探索者 A", kind: "student" }],
      edges: [],
      metrics: {},
    },
    human_only: { nodes: [], edges: [], metrics: {} },
    lineage_adjusted: { nodes: [], edges: [], metrics: {} },
  },
};

function studentBundle(overrides: Record<string, unknown> = {}) {
  return {
    projectionKey: "trace.student_bundle",
    roomId: ROOM_ID,
    analysisEpoch: EPOCH,
    projectionVersion: 1,
    warnings: [],
    completeThroughRoomSeq: 4,
    watermarkEventTime: "2026-08-30T08:10:00.000Z",
    requiresReplay: false,
    payload: {
      interpretation: TRACE_STUDENT_INTERPRETATION_ZH_HANT,
      windows: { recent_10m: WINDOW, session_45m: WINDOW },
      ...overrides,
    },
  };
}

describe("student-safe TRACE view", () => {
  it("shows the complete claim ceiling, never a shortened one", () => {
    const dom = render(
      <TracePanel slot={{ availability: "ready", snapshot: studentBundle() } as never} onRetry={() => undefined} />,
    );
    const disclosure = dom.container.querySelector(".analysis-interpretation");
    expect(disclosure?.textContent).toBe(TRACE_STUDENT_INTERPRETATION_ZH_HANT);
    // Every clause has to survive: each one denies a different inference a
    // reader would otherwise make from a graph of who talked to whom.
    for (const clause of ["友情", "地位", "能力", "貢獻價值", "學習成績", "心理關係", "Agent 因果效果"]) {
      expect(disclosure?.textContent).toContain(clause);
    }
    expect(disclosure?.getAttribute("data-claim-ceiling")).toBe("expected");
  });

  it("still shows the full disclosure when a bundle arrives with a shortened one", () => {
    const dom = render(
      <TracePanel
        slot={{ availability: "ready", snapshot: studentBundle({ interpretation: "互動圖" }) } as never}
        onRetry={() => undefined}
      />,
    );
    const disclosure = dom.container.querySelector(".analysis-interpretation");
    // A stale disclosure is better than a missing one; the divergence is
    // marked rather than silently rendered.
    expect(disclosure?.textContent).toBe(TRACE_STUDENT_INTERPRETATION_ZH_HANT);
    expect(disclosure?.getAttribute("data-claim-ceiling")).toBe("unexpected");
    expect(interpretationMatchesClaimCeiling("互動圖")).toBe(false);
  });

  it("puts no room or actor identifier anywhere in the student's DOM", () => {
    const dom = render(
      <TracePanel slot={{ availability: "ready", snapshot: studentBundle() } as never} onRetry={() => undefined} />,
    );
    const html = dom.container.innerHTML;
    expect(html).not.toContain(ROOM_ID);
    expect(html).not.toContain(ACTOR_ID);
    expect(html).not.toContain(EPOCH);
  });

  it("names no individual ranking, ability or contribution score", () => {
    const dom = render(
      <TracePanel slot={{ availability: "ready", snapshot: studentBundle() } as never} onRetry={() => undefined} />,
    );
    const text = dom.container.textContent ?? "";
    // The words may appear only inside the denial that they are produced.
    for (const forbidden of ["個人排名：", "能力分數", "貢獻分數："]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
