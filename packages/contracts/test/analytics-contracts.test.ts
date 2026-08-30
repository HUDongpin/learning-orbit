import { describe, expect, it } from "vitest";
import { analyticsContract, analyticsHttpContract } from "../src/index.js";
import goldenEcho from "../../test-fixtures/analytics/golden-echo-projection.json" with { type: "json" };
import goldenTrace from "../../test-fixtures/analytics/golden-trace-projections.json" with { type: "json" };

const uuid = "00000000-0000-4000-8000-000000000010";

const echoPatch = {
  analysisEpoch: goldenEcho.analysisEpoch,
  algorithmVersion: goldenEcho.algorithmVersion,
  parameterHash: goldenEcho.parameterHash,
  projectionVersion: 2,
  baseVersion: 1,
  completeThroughRoomSeq: 6,
  requiresReplay: false,
  warnings: [],
  nodesAdded: [],
  nodesUpdated: [],
  nodesHidden: [],
  edgesAdded: [],
  edgesUpdated: [],
  edgesHidden: [],
  positionUpdates: [],
  changeScore: 0,
  reasonCodes: [],
  evidenceRefs: [],
};

describe("analytics contract spine", () => {
  it("accepts an evidence-backed ECHO snapshot and rejects collapsed fields", () => {
    expect(analyticsContract.parseEchoSnapshot(goldenEcho)).toMatchObject({ projectionKey: "echo.teacher_shadow" });
    expect(() => analyticsContract.parseEchoSnapshot({ ...goldenEcho, confidence: 0.9 })).toThrow("INVALID_ECHO_PROJECTION");
  });

  it("binds ECHO role metadata and validates evidence spans inside patches", () => {
    const approvedNodes = goldenEcho.payload.nodes.map((node) => ({ ...node, reviewStatus: "approved" }));
    const approvedEdges = goldenEcho.payload.edges.map((edge) => ({ ...edge, reviewStatus: "approved" }));
    expect(analyticsContract.parseEchoSnapshot({
      ...goldenEcho,
      projectionKey: "echo.student_approved",
      reviewStatus: "approved",
      displayStatus: "student_approved",
      payload: { nodes: approvedNodes, edges: approvedEdges },
    })).toMatchObject({ projectionKey: "echo.student_approved", reviewStatus: "approved" });
    expect(() => analyticsContract.parseEchoSnapshot({
      ...goldenEcho,
      projectionKey: "echo.student_approved",
    })).toThrow("INVALID_ECHO_PROJECTION");
    expect(() => analyticsContract.parseEchoPatch({
      ...echoPatch,
      edgesAdded: [{
        ...goldenEcho.payload.edges[0],
        evidenceRefs: [{
          ...goldenEcho.payload.edges[0]!.evidenceRefs[0],
          start: 9,
          end: 2,
        }],
      }],
    })).toThrow("INVALID_ECHO_EVIDENCE_SPAN");
  });

  it("rejects reversed TRACE windows, unsafe student identities, and dangling edges", () => {
    const student = goldenTrace.student;
    expect(analyticsContract.parseTrace(student)).toMatchObject({ projectionKey: "trace.student_bundle" });
    expect(analyticsContract.parseTrace({
      ...student,
      payload: {
        ...student.payload,
        windows: {
          ...student.payload.windows,
          session_45m: {
            ...student.payload.windows.session_45m,
            windowStartEventTime: "2026-08-28T09:00:00Z",
          },
        },
      },
    })).toMatchObject({ projectionKey: "trace.student_bundle" });
    expect(() => analyticsContract.parseTrace({
      ...student,
      payload: {
        ...student.payload,
        windows: {
          ...student.payload.windows,
          recent_10m: {
            ...student.payload.windows.recent_10m,
            windowStartEventTime: "2026-08-28T09:06:00Z",
          },
        },
      },
    })).toThrow("INVALID_TRACE_PROJECTION");
    const unsafeNode = {
      nodeId: "00000000-0000-4000-8000-000000000099",
      label: "Alice alice@example.edu",
      kind: "learner",
    };
    expect(() => analyticsContract.parseTrace({
      ...student,
      payload: {
        ...student.payload,
        windows: {
          ...student.payload.windows,
          recent_10m: {
            ...student.payload.windows.recent_10m,
            views: {
              ...student.payload.windows.recent_10m.views,
              observed: {
                ...student.payload.windows.recent_10m.views.observed,
                nodes: [unsafeNode],
                edges: [{ sourceNodeId: unsafeNode.nodeId, targetNodeId: "missing", layer: "communication" }],
              },
            },
          },
        },
      },
    })).toThrow("INVALID_TRACE_PROJECTION");
  });

  it("keeps derived confidence/status separate and closes artifact pages", () => {
    const artifact = {
      schemaVersion: 1, artifactId: uuid, lineageId: "00000000-0000-4000-8000-000000000011", roomId: uuid,
      eventId: "00000000-0000-4000-8000-000000000012", roomSeq: 1, sourceMediaId: null,
      sourceModality: "text", derivation: "direct", text: "太陽提供能量。", normalizedTextSha256: "a".repeat(64),
      sourceConfidenceRaw: 1, sourceConfidenceCalibrated: null, provider: "learner-authored", modelVersion: "direct-text-v1",
      languageTag: "zh-Hant", spans: [], reviewStatus: "unreviewed", displayStatus: "hidden", warnings: [],
      supersedesArtifactId: null, active: true, createdAt: "2026-08-30T09:00:00.000Z",
    };
    expect(analyticsContract.parseArtifactPage({ items: [artifact], throughRoomSeq: 1, nextAfterArtifactId: null, includeHistory: false }).items).toHaveLength(1);
    expect(() => analyticsContract.parseArtifact({ ...artifact, prompt: "secret" })).toThrow("INVALID_DERIVED_TEXT_ARTIFACT");
  });

  it("parses closed patch-page, timeline, and resync HTTP response contracts", () => {
    expect(analyticsHttpContract.parsePatchPage({ patches: [echoPatch] }).patches).toHaveLength(1);
    expect(analyticsHttpContract.parseTimeline({
      baseSnapshot: goldenEcho,
      patches: [echoPatch],
      truncatedBeforeVersion: 1,
      headVersion: 2,
    })).toMatchObject({ headVersion: 2, truncatedBeforeVersion: 1 });
    expect(analyticsHttpContract.parseResync({
      code: "SNAPSHOT_RESYNC_REQUIRED",
      snapshotUrl: `/v1/rooms/${uuid}/analytics/echo.teacher_shadow/latest`,
    })).toMatchObject({ code: "SNAPSHOT_RESYNC_REQUIRED" });

    expect(() => analyticsHttpContract.parsePatchPage({ patches: [echoPatch], token: "leak" }))
      .toThrow("INVALID_ANALYTICS_PATCH_PAGE");
    expect(() => analyticsHttpContract.parseTimeline({
      baseSnapshot: goldenEcho,
      patches: [{ ...echoPatch, baseVersion: 0 }],
      truncatedBeforeVersion: 1,
      headVersion: 2,
    })).toThrow("INVALID_ANALYTICS_TIMELINE");
    expect(() => analyticsHttpContract.parseTimeline({
      baseSnapshot: { ...goldenEcho, projectionKey: "echo.student_approved" },
      patches: [echoPatch],
      truncatedBeforeVersion: 1,
      headVersion: 2,
    })).toThrow("INVALID_ECHO_PROJECTION");
    expect(() => analyticsHttpContract.parseResync({
      code: "SNAPSHOT_RESYNC_REQUIRED",
      snapshotUrl: "https://evil.example/snapshot",
    })).toThrow("INVALID_ANALYTICS_RESYNC");
  });
});
