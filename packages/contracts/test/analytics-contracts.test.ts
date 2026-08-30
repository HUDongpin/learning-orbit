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
const approvedStudentNodes = goldenEcho.payload.nodes.map((node) => ({ ...node, reviewStatus: "approved" as const }));
const approvedStudentEdges = goldenEcho.payload.edges.map(({
  channels: _channels,
  activityScore: _activityScore,
  evidenceRefs: _evidenceRefs,
  ...edge
}) => ({ ...edge, reviewStatus: "approved" as const }));
const studentEchoSnapshot = {
  ...goldenEcho,
  projectionKey: "echo.student_approved" as const,
  reviewStatus: "approved" as const,
  displayStatus: "student_approved" as const,
  payload: { nodes: approvedStudentNodes, edges: approvedStudentEdges },
};
const { evidenceRefs: _teacherPatchEvidenceRefs, ...studentEchoPatchCommon } = echoPatch;
const studentEchoPatch = {
  ...studentEchoPatchCommon,
  nodesAdded: approvedStudentNodes,
  edgesAdded: approvedStudentEdges,
};

describe("analytics contract spine", () => {
  it("accepts an evidence-backed ECHO snapshot and rejects collapsed fields", () => {
    expect(analyticsContract.parseEchoSnapshot(goldenEcho)).toMatchObject({ projectionKey: "echo.teacher_shadow" });
    expect(() => analyticsContract.parseEchoSnapshot({ ...goldenEcho, confidence: 0.9 })).toThrow("INVALID_ECHO_PROJECTION");
  });

  it("keeps student ECHO snapshots free of teacher evidence and weight fields", () => {
    const studentWithTeacherFields = {
      ...goldenEcho,
      projectionKey: "echo.student_approved",
      reviewStatus: "approved",
      displayStatus: "student_approved",
      payload: {
        nodes: approvedStudentNodes,
        edges: goldenEcho.payload.edges.map((edge) => ({ ...edge, reviewStatus: "approved" })),
      },
    };
    expect(() => analyticsContract.parseStudentEchoSnapshot(studentWithTeacherFields))
      .toThrow("INVALID_STUDENT_ECHO_PROJECTION");

    expect(analyticsContract.parseStudentEchoSnapshot(studentEchoSnapshot))
      .toMatchObject({ projectionKey: "echo.student_approved", reviewStatus: "approved" });
  });

  it("distinguishes an empty unreviewed student ECHO snapshot from approved content", () => {
    const empty = {
      ...goldenEcho,
      projectionKey: "echo.student_approved",
      reviewStatus: "unreviewed",
      displayStatus: "student_approved",
      payload: { nodes: [], edges: [] },
    };
    expect(analyticsContract.parseStudentEchoSnapshot(empty))
      .toMatchObject({ projectionKey: "echo.student_approved", reviewStatus: "unreviewed" });
    expect(() => analyticsContract.parseStudentEchoSnapshot({ ...empty, reviewStatus: "approved" }))
      .toThrow("INVALID_STUDENT_ECHO_PROJECTION");
    expect(() => analyticsContract.parseEchoSnapshot({
      ...goldenEcho,
      projectionKey: "echo.student_approved",
    })).toThrow("INVALID_ECHO_PROJECTION");
  });

  it("validates evidence spans inside teacher ECHO patches", () => {
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

  it("uses distinct teacher and student ECHO patch contracts", () => {
    expect(analyticsContract.parseStudentEchoPatch(studentEchoPatch)).toMatchObject({
      projectionVersion: 2,
      edgesAdded: [expect.not.objectContaining({ evidenceRefs: expect.anything() })],
    });
    expect(() => analyticsContract.parseStudentEchoPatch({
      ...echoPatch,
      edgesAdded: goldenEcho.payload.edges.map((edge) => ({ ...edge, reviewStatus: "approved" })),
    })).toThrow("INVALID_STUDENT_ECHO_PATCH");
    expect(analyticsContract.parseTeacherEchoPatch({
      ...echoPatch,
      edgesAdded: goldenEcho.payload.edges,
    })).toMatchObject({ projectionVersion: 2 });
  });

  it("binds patch pages and timelines to room, role key, and analysis epoch", () => {
    const studentPatchPage = {
      schemaVersion: 1,
      roomId: uuid,
      projectionKey: "echo.student_approved",
      analysisEpoch: goldenEcho.analysisEpoch,
      patches: [studentEchoPatch],
    };
    expect(analyticsHttpContract.parseStudentPatchPage(studentPatchPage))
      .toMatchObject({ projectionKey: "echo.student_approved", roomId: uuid });
    expect(() => analyticsHttpContract.parseStudentPatchPage({
      ...studentPatchPage,
      analysisEpoch: "00000000-0000-4000-8000-000000000999",
    })).toThrow("INVALID_STUDENT_ANALYTICS_PATCH_PAGE");

    const studentTimeline = {
      schemaVersion: 1,
      roomId: uuid,
      projectionKey: "echo.student_approved",
      analysisEpoch: goldenEcho.analysisEpoch,
      baseSnapshot: studentEchoSnapshot,
      patches: [studentEchoPatch],
      truncatedBeforeVersion: 1,
      headVersion: 2,
    };
    expect(analyticsHttpContract.parseStudentTimeline(studentTimeline))
      .toMatchObject({ projectionKey: "echo.student_approved", headVersion: 2 });
    expect(() => analyticsHttpContract.parseStudentTimeline({
      ...studentTimeline,
      projectionKey: "echo.teacher_shadow",
    })).toThrow("INVALID_STUDENT_ANALYTICS_TIMELINE");
    expect(() => analyticsHttpContract.parseStudentTimeline({
      ...studentTimeline,
      baseSnapshot: { ...studentEchoSnapshot, completeThroughRoomSeq: 7 },
    })).toThrow("INVALID_ANALYTICS_TIMELINE");
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
    expect(() => analyticsContract.parseTrace({
      ...goldenTrace.teacher,
      payload: {
        ...goldenTrace.teacher.payload,
        windows: {
          ...goldenTrace.teacher.payload.windows,
          recent_10m: {
            ...goldenTrace.teacher.payload.windows.recent_10m,
            views: {
              ...goldenTrace.teacher.payload.windows.recent_10m.views,
              observed: {
                ...goldenTrace.teacher.payload.windows.recent_10m.views.observed,
                nodes: [{ nodeId: unsafeNode.nodeId, label: unsafeNode.nodeId, kind: "learner" }],
              },
            },
          },
        },
      },
    })).toThrow("INVALID_TRACE_PROJECTION");
    expect(() => analyticsContract.parseTrace({
      ...goldenTrace.teacher,
      payload: {
        ...goldenTrace.teacher.payload,
        actorMapping: {
          "actor-x": {
            actorId: "00000000-0000-4000-8000-000000000099",
            pseudonym: "探索者 A",
            kind: "learner",
          },
        },
        windows: {
          ...goldenTrace.teacher.payload.windows,
          recent_10m: {
            ...goldenTrace.teacher.payload.windows.recent_10m,
            views: {
              ...goldenTrace.teacher.payload.windows.recent_10m.views,
              observed: {
                ...goldenTrace.teacher.payload.windows.recent_10m.views.observed,
                nodes: [{ nodeId: "actor-x", label: "Nova Agent", kind: "learner" }],
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
    const teacherContext = {
      schemaVersion: 1,
      roomId: uuid,
      projectionKey: "echo.teacher_shadow",
      analysisEpoch: goldenEcho.analysisEpoch,
    } as const;
    expect(analyticsHttpContract.parsePatchPage({ ...teacherContext, patches: [echoPatch] }).patches).toHaveLength(1);
    expect(analyticsHttpContract.parseTimeline({
      ...teacherContext,
      baseSnapshot: goldenEcho,
      patches: [echoPatch],
      truncatedBeforeVersion: 1,
      headVersion: 2,
    })).toMatchObject({ headVersion: 2, truncatedBeforeVersion: 1 });
    expect(analyticsHttpContract.parseResync({
      code: "SNAPSHOT_RESYNC_REQUIRED",
      snapshotUrl: `/v1/rooms/${uuid}/analytics/echo.teacher_shadow/latest`,
    })).toMatchObject({ code: "SNAPSHOT_RESYNC_REQUIRED" });

    expect(() => analyticsHttpContract.parsePatchPage({ ...teacherContext, patches: [echoPatch], token: "leak" }))
      .toThrow("INVALID_ANALYTICS_PATCH_PAGE");
    expect(() => analyticsHttpContract.parseTimeline({
      ...teacherContext,
      baseSnapshot: goldenEcho,
      patches: [{ ...echoPatch, baseVersion: 0 }],
      truncatedBeforeVersion: 1,
      headVersion: 2,
    })).toThrow("INVALID_ANALYTICS_TIMELINE");
    expect(() => analyticsHttpContract.parseTimeline({
      ...teacherContext,
      baseSnapshot: { ...goldenEcho, projectionKey: "echo.student_approved" },
      patches: [echoPatch],
      truncatedBeforeVersion: 1,
      headVersion: 2,
    })).toThrow("INVALID_ANALYTICS_TIMELINE");
    expect(() => analyticsHttpContract.parseResync({
      code: "SNAPSHOT_RESYNC_REQUIRED",
      snapshotUrl: "https://evil.example/snapshot",
    })).toThrow("INVALID_ANALYTICS_RESYNC");
  });
});
