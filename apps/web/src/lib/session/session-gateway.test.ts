import { describe, expect, it, vi } from "vitest";
import type { AnalyticsReviewCommand } from "@learning-orbit/contracts";

import {
  FetchSessionGateway,
  readBoundedExportText,
  SessionGatewayError,
  normalizeClassroomCode,
} from "./session-gateway.js";

const joined = {
  roomMemberId: "00000000-0000-4000-8000-000000000011",
  actorId: "00000000-0000-4000-8000-000000000012",
  pseudonym: "探索者 A",
};
const studentSession = {
  role: "student" as const,
  roomId: "00000000-0000-4000-8000-000000000010",
  ...joined,
  nova: {
    actorId: "00000000-0000-4000-8000-000000000013",
    actorKind: "agent" as const,
    actorRole: "socratic_facilitator" as const,
    displayName: "Nova Agent" as const,
  },
};

const teacherRoomList = {
  rooms: [{
    roomId: "00000000-0000-4000-8000-000000000020",
    topic: "生態系統探究",
    status: "scheduled" as const,
    durationSeconds: 2700 as const,
    startsAt: null,
    closesAt: null,
    createdAt: "2026-08-31T01:00:00.000Z",
  }],
  truncated: false,
};

const createdRoom = {
  room: {
    roomId: "00000000-0000-4000-8000-000000000020",
    roomCode: "ABC234",
    status: "scheduled" as const,
    durationSeconds: 2700 as const,
    nova: studentSession.nova,
  },
  seatInvites: ["A", "B", "C", "D"].map((letter, index) => ({
    roomMemberId: `00000000-0000-4000-8000-00000000003${index}`,
    actorId: `00000000-0000-4000-8000-00000000004${index}`,
    pseudonym: `探索者 ${letter}`,
    code: `ABC234567${index + 2}`,
  })),
};

const roomDetails = {
  roomId: createdRoom.room.roomId,
  topic: "生態系統探究",
  status: "scheduled" as const,
  durationSeconds: 2700 as const,
  startsAt: null,
  closesAt: null,
  nova: studentSession.nova,
  participants: ["A", "B", "C", "D"].map((letter, index) => ({
    actorId: `00000000-0000-4000-8000-00000000004${index}`,
    pseudonym: `探索者 ${letter}`,
    actorKind: "human" as const,
    actorRole: "student" as const,
  })),
};
const mediaId = "00000000-0000-4000-8000-000000000701";
const uploadGrant = {
  mediaId,
  uploadUrl: "https://storage.learning-orbit.test/upload/signed",
  requiredHeaders: { "x-amz-checksum-sha256": "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=" },
  expiresAt: "2026-08-31T01:05:00.000Z",
};
const mediaView = {
  mediaId,
  kind: "image" as const,
  state: "processing" as const,
  detectedMime: "image/png",
  sizeBytes: 3,
  altText: "池塘草圖",
  caption: null,
  failureCode: null,
  createdAt: "2026-08-31T01:00:00.000Z",
  updatedAt: "2026-08-31T01:01:00.000Z",
};
const agentCurrent = {
  roomId: createdRoom.room.roomId,
  run: null,
  serviceHealth: "unavailable" as const,
  agentEnabled: false,
  updatedAt: "2026-08-31T01:01:00.000Z",
};
const analyticsEpoch = "00000000-0000-4000-8000-000000000901";
const analyticsParameterHash = "b".repeat(64);
const echoLatest = {
  schemaVersion: 1 as const,
  projectionKey: "echo.student_approved" as const,
  roomId: createdRoom.room.roomId,
  analysisEpoch: analyticsEpoch,
  algorithmVersion: "echo-v1",
  parameterHash: analyticsParameterHash,
  projectionVersion: 1,
  baseVersion: 0,
  completeThroughRoomSeq: 4,
  watermarkEventTime: "2026-08-31T01:00:00.000Z",
  requiresReplay: false,
  evidenceStatus: "active" as const,
  reviewStatus: "unreviewed" as const,
  displayStatus: "student_approved" as const,
  warnings: [],
  payload: { nodes: [], edges: [] },
};
const echoPatch = {
  analysisEpoch: analyticsEpoch,
  algorithmVersion: "echo-v1",
  parameterHash: analyticsParameterHash,
  projectionVersion: 2,
  baseVersion: 1,
  completeThroughRoomSeq: 5,
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
};
const traceView = {
  nodes: [],
  edges: [],
  metrics: { participationBalance: 0, reciprocity: 0, agentShare: 0, semanticCoverage: 0 },
  warnings: ["small_group_interpretation_warning"],
};
const traceLatest = {
  ...echoLatest,
  projectionKey: "trace.student_bundle" as const,
  algorithmVersion: "trace-v1",
  parameterHash: "c".repeat(64),
  reviewStatus: "approved" as const,
  displayStatus: "student_aggregate" as const,
  warnings: ["small_group_interpretation_warning"],
  payload: {
    windows: {
      recent_10m: {
        windowStartEventTime: "2026-08-31T00:50:00.000Z",
        windowEndEventTime: "2026-08-31T01:00:00.000Z",
        views: { observed: traceView, human_only: traceView, lineage_adjusted: traceView },
      },
      session_45m: {
        windowStartEventTime: "2026-08-31T00:15:00.000Z",
        windowEndEventTime: "2026-08-31T01:00:00.000Z",
        views: { observed: traceView, human_only: traceView, lineage_adjusted: traceView },
      },
    },
    interpretation: "此圖呈現系統觀測到的近期互動事件，不等同友情、地位、能力、貢獻價值、學習成績、心理關係或 Agent 因果效果。" as const,
  },
};
const artifactId = "00000000-0000-4000-8000-000000000a01";
const derivedTextArtifact = {
  schemaVersion: 1 as const,
  artifactId,
  lineageId: "00000000-0000-4000-8000-000000000a02",
  roomId: createdRoom.room.roomId,
  eventId: "00000000-0000-4000-8000-000000000a03",
  roomSeq: 4,
  sourceMediaId: null,
  sourceModality: "text" as const,
  derivation: "direct" as const,
  text: "太陽提供能量給生產者。",
  normalizedTextSha256: "d".repeat(64),
  sourceConfidenceRaw: 1,
  sourceConfidenceCalibrated: null,
  provider: "learner-authored",
  modelVersion: "direct-text-v1",
  languageTag: "zh-Hant",
  spans: [],
  reviewStatus: "unreviewed" as const,
  displayStatus: "teacher_shadow" as const,
  warnings: [],
  supersedesArtifactId: null,
  active: true,
  createdAt: "2026-08-31T01:00:00.000Z",
};
const artifactPage = {
  items: [derivedTextArtifact],
  throughRoomSeq: 4,
  nextAfterArtifactId: artifactId,
  includeHistory: false,
};
const reviewEventId = "00000000-0000-4000-8000-000000000b01";
const replayJobId = "00000000-0000-4000-8000-000000000b02";
const correctionTargetId = "00000000-0000-4000-8000-000000000b03";
const correctionEventId = "00000000-0000-4000-8000-000000000b04";
const reviewCommands = [
  {
    targetType: "derived_text",
    targetId: artifactId,
    decision: "approve",
    rationale: "證據來源與文字一致。",
    expectedAnalysisEpoch: analyticsEpoch,
    expectedProjectionVersion: 1,
  },
  {
    targetArtifactId: artifactId,
    correctionKind: "replace_text",
    replacement: { text: "太陽把能量傳給生產者。", languageTag: "zh-Hant" },
    reason: "修正文字。",
    expectedAnalysisEpoch: analyticsEpoch,
    expectedProjectionVersion: 1,
  },
  {
    targetProjectionEdgeId: correctionTargetId,
    correctionKind: "replace_evidence_span",
    target: { eventId: correctionEventId, start: 0, end: 2 },
    replacement: { eventId: correctionEventId, start: 0, end: 4 },
    reason: "擴充證據範圍。",
    expectedAnalysisEpoch: analyticsEpoch,
    expectedProjectionVersion: 1,
  },
  {
    targetProjectionEdgeId: correctionTargetId,
    correctionKind: "replace_relation",
    replacement: { head: "producer", predicate: "receives energy from", tail: "sun", relationFamily: "energy_flow" },
    reason: "修正關係方向。",
    expectedAnalysisEpoch: analyticsEpoch,
    expectedProjectionVersion: 1,
  },
  {
    targetCanonicalNodeId: "producer",
    correctionKind: "merge_alias",
    replacement: { aliasNodeId: "green-plant" },
    reason: "合併同義概念。",
    expectedAnalysisEpoch: analyticsEpoch,
    expectedProjectionVersion: 1,
  },
  {
    targetCanonicalNodeId: "producer",
    correctionKind: "split_alias",
    replacement: { aliasNodeId: "plant", newCanonicalNodeId: "aquatic-plant", newLabel: "水生植物" },
    reason: "拆分不同概念。",
    expectedAnalysisEpoch: analyticsEpoch,
    expectedProjectionVersion: 1,
  },
  {
    targetCorrectionEventId: correctionEventId,
    correctionKind: "undo_merge",
    replacement: {},
    reason: "撤銷錯誤合併。",
    expectedAnalysisEpoch: analyticsEpoch,
    expectedProjectionVersion: 1,
  },
  {
    targetType: "projection",
    targetId: correctionTargetId,
    correctionKind: "retract",
    replacement: {},
    reason: "撤回錯誤關係。",
    expectedAnalysisEpoch: analyticsEpoch,
    expectedProjectionVersion: 1,
  },
] as const satisfies readonly AnalyticsReviewCommand[];
const deletionJobId = "00000000-0000-4000-8000-000000000c01";
const deletionAccepted = { deletionJobId, status: "queued" as const };
const deletionRunning = {
  deletionJobId,
  status: "running" as const,
  nextPollAfterMs: 1000,
  failureCode: null,
};
const deletionCompleted = {
  deletionJobId,
  status: "completed" as const,
  receipt: {
    receiptVersion: 1 as const,
    surfacesVerified: [
      "agent_runs", "artifacts", "caches", "derivatives",
      "events", "media", "projections", "provider_copies",
    ] as const,
    completedAt: "2026-08-31T01:10:00.000Z",
  },
};
const exportedEvent = {
  eventId: "00000000-0000-4000-8000-000000000d01",
  schemaVersion: 1 as const,
  roomId: createdRoom.room.roomId,
  roomSeq: 1,
  type: "room.opened",
  actorId: "00000000-0000-4000-8000-000000000d02",
  actorKind: "human" as const,
  actorRole: "teacher" as const,
  revision: 1,
  operation: "add" as const,
  eventTime: "2026-08-31T01:00:00.000Z",
  ingestTime: "2026-08-31T01:00:00.001Z",
  causationId: "00000000-0000-4000-8000-000000000d03",
  correlationId: "00000000-0000-4000-8000-000000000d04",
  payload: {
    startsAt: "2026-08-31T01:00:00.000Z",
    closesAt: "2026-08-31T01:45:00.000Z",
  },
};
const exportDocument = {
  schemaVersion: 1 as const,
  exportKind: "teacher_room" as const,
  roomId: createdRoom.room.roomId,
  throughRoomSeq: 1,
  events: [exportedEvent],
  artifacts: [],
  projections: [],
  provenance: { artifactSources: [], projectionSources: [] },
};
const exportCsvHeader = "recordType,json\n";
const csvJsonRow = (kind: string, value: unknown) => (
  `${kind},"${JSON.stringify(value).replaceAll('"', '""')}"\n`
);
const exportCsv = exportCsvHeader
  + csvJsonRow("manifest", {
    schemaVersion: 1,
    exportKind: "teacher_room",
    roomId: createdRoom.room.roomId,
    throughRoomSeq: 1,
  })
  + csvJsonRow("event", exportedEvent);

const exported = (
  body: BodyInit,
  contentType: string,
  contentDisposition: string,
  status = 200,
) => new Response(body, {
  status,
  headers: {
    "content-type": contentType,
    "content-disposition": contentDisposition,
  },
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

describe("typed SessionGateway", () => {
  it("normalizes classroom codes without persisting them", () => {
    expect(normalizeClassroomCode(" ab c-23\n")).toBe("ABC-23");
  });

  it("joins through the canonical route then rehydrates server identity before returning", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(joined))
      .mockResolvedValueOnce(json(studentSession));
    const gateway = new FetchSessionGateway({ fetch });
    await expect(gateway.joinStudent({ roomCode: " abc 234 ", seatCode: " def 234 5678 " }))
      .resolves.toEqual(studentSession);
    expect(fetch).toHaveBeenNthCalledWith(1, "/v1/rooms/join", expect.objectContaining({
      method: "POST",
      credentials: "include",
      cache: "no-store",
      body: JSON.stringify({ roomCode: "ABC234", seatCode: "DEF2345678" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, "/v1/auth/session", expect.objectContaining({
      method: "GET",
      credentials: "include",
      cache: "no-store",
    }));
  });

  it("fails closed when the post-join session identity disagrees", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(joined))
      .mockResolvedValueOnce(json({ ...studentSession, actorId: "00000000-0000-4000-8000-000000000099" }));
    await expect(new FetchSessionGateway({ fetch }).joinStudent({
      roomCode: "ABC234",
      seatCode: "DEF2345678",
    })).rejects.toThrow("SESSION_IDENTITY_MISMATCH");
  });

  it("parses only endpoint-legal errors and generated success responses", async () => {
    const unauthorized = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "AUTH_REQUIRED" }, 401)) });
    await expect(unauthorized.getSession()).rejects.toEqual(new SessionGatewayError("AUTH_REQUIRED"));

    const unknown = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "UNKNOWN" }, 401)) });
    await expect(unknown.getSession()).rejects.toThrow("SESSION_RESPONSE_INVALID");

    const wrongStatus = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "JOIN_FORBIDDEN" }, 401)) });
    await expect(wrongStatus.joinStudent({ roomCode: "ABC234", seatCode: "DEF2345678" }))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("binds a browser brand-checked fetch transport to globalThis", async () => {
    let receiver: unknown;
    const fetch = function (this: unknown) {
      receiver = this;
      if (this !== globalThis) throw new TypeError("illegal receiver");
      return Promise.resolve(json({ code: "AUTH_REQUIRED" }, 401));
    } as typeof globalThis.fetch;

    vi.stubGlobal("fetch", fetch);
    try {
      await expect(new FetchSessionGateway().getSession())
        .rejects.toEqual(new SessionGatewayError("AUTH_REQUIRED"));
      expect(receiver).toBe(globalThis);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends normalized teacher email but exposes only the generic accepted result", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ accepted: true }, 202));
    await expect(new FetchSessionGateway({ fetch }).requestTeacherMagicLink({ email: " Teacher@Example.EDU " }))
      .resolves.toEqual({ accepted: true });
    expect(fetch).toHaveBeenCalledWith("/v1/auth/teacher/magic-link", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ email: "teacher@example.edu" }),
    }));

    const limited = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "RATE_LIMITED" }, 429)) });
    await expect(limited.requestTeacherMagicLink({ email: "teacher@example.edu" }))
      .rejects.toEqual(new SessionGatewayError("RATE_LIMITED"));
    const mismatched = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "ROOM_NOT_FOUND" }, 429)) });
    await expect(mismatched.requestTeacherMagicLink({ email: "teacher@example.edu" }))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
    const extra = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ statusCode: 429, code: "RATE_LIMITED" }, 429)) });
    await expect(extra.requestTeacherMagicLink({ email: "teacher@example.edu" }))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("requires a real 204 logout and never serializes transport details", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(new FetchSessionGateway({ fetch }).logout()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("/v1/auth/session", expect.objectContaining({
      method: "DELETE",
      credentials: "include",
    }));
    const proxiedEmpty = {
      status: 204,
      body: new ReadableStream(),
      text: vi.fn(async () => ""),
    } as unknown as Response;
    await expect(new FetchSessionGateway({
      fetch: vi.fn().mockResolvedValue(proxiedEmpty),
    }).logout()).resolves.toBeUndefined();
    const proxiedNonEmpty = {
      ...proxiedEmpty,
      text: vi.fn(async () => "unexpected"),
    } as unknown as Response;
    await expect(new FetchSessionGateway({
      fetch: vi.fn().mockResolvedValue(proxiedNonEmpty),
    }).logout()).rejects.toThrow("SESSION_RESPONSE_INVALID");
    const failed = new FetchSessionGateway({ fetch: vi.fn().mockRejectedValue(new Error("cookie=secret")) });
    await expect(failed.getSession()).rejects.toThrow("SESSION_NETWORK_FAILURE");
  });

  it("lists only generated teacher room summaries through the canonical route", async () => {
    const fetch = vi.fn().mockResolvedValue(json(teacherRoomList));
    await expect(new FetchSessionGateway({ fetch }).getTeacherRooms()).resolves.toEqual(teacherRoomList);
    expect(fetch).toHaveBeenCalledWith("/v1/teacher/rooms", expect.objectContaining({
      method: "GET",
      credentials: "include",
      cache: "no-store",
    }));

    const leaked = new FetchSessionGateway({
      fetch: vi.fn().mockResolvedValue(json({
        ...teacherRoomList,
        rooms: [{ ...teacherRoomList.rooms[0], roomCode: "ABC234" }],
      })),
    });
    await expect(leaked.getTeacherRooms()).rejects.toThrow("SESSION_RESPONSE_INVALID");

    for (const [status, code] of [[401, "AUTH_REQUIRED"], [404, "ROOM_NOT_FOUND"], [503, "ROOM_LIST_UNAVAILABLE"]] as const) {
      const legal = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code }, status)) });
      await expect(legal.getTeacherRooms()).rejects.toEqual(new SessionGatewayError(code));
    }
    for (const [status, code] of [[401, "ROOM_NOT_FOUND"], [404, "ROOM_LIST_UNAVAILABLE"], [503, "ROOM_NOT_FOUND"]] as const) {
      const illegal = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code }, status)) });
      await expect(illegal.getTeacherRooms()).rejects.toThrow("SESSION_RESPONSE_INVALID");
    }
  });

  it("creates a room with the generated request and preserves one-time invite codes only in the response", async () => {
    const fetch = vi.fn().mockResolvedValue(json(createdRoom, 201));
    await expect(new FetchSessionGateway({ fetch }).createRoom({ topic: " 生態系統探究 " })).resolves.toEqual(createdRoom);
    expect(fetch).toHaveBeenCalledWith("/v1/rooms", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ topic: "生態系統探究" }),
    }));
  });

  it("loads room details through the shared route and hides endpoint-illegal errors", async () => {
    const fetch = vi.fn().mockResolvedValue(json(roomDetails));
    await expect(new FetchSessionGateway({ fetch }).getRoom(createdRoom.room.roomId)).resolves.toEqual(roomDetails);
    expect(fetch).toHaveBeenCalledWith(`/v1/rooms/${createdRoom.room.roomId}`, expect.objectContaining({
      method: "GET",
      credentials: "include",
    }));

    const illegal = new FetchSessionGateway({
      fetch: vi.fn().mockResolvedValue(json({ code: "JOIN_FORBIDDEN" }, 404)),
    });
    await expect(illegal.getRoom(createdRoom.room.roomId)).rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("loads a generated, cursor-bound room event page through the canonical route", async () => {
    const page = { events: [], throughRoomSeq: 4, nextAfterSeq: 4 };
    const fetch = vi.fn().mockResolvedValue(json(page));
    await expect(new FetchSessionGateway({ fetch }).getRoomEvents(createdRoom.room.roomId, 4, 50))
      .resolves.toEqual(page);
    expect(fetch).toHaveBeenCalledWith(`/v1/rooms/${createdRoom.room.roomId}/events?afterSeq=4&limit=50`, expect.objectContaining({
      method: "GET",
      credentials: "include",
      cache: "no-store",
    }));

    const hidden = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "ROOM_NOT_FOUND" }, 404)) });
    await expect(hidden.getRoomEvents(createdRoom.room.roomId, 0))
      .rejects.toEqual(new SessionGatewayError("ROOM_NOT_FOUND"));
    const leakedForbidden = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "FORBIDDEN" }, 403)) });
    await expect(leakedForbidden.getRoomEvents(createdRoom.room.roomId, 0))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
    const invalid = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ ...page, secret: true })) });
    await expect(invalid.getRoomEvents(createdRoom.room.roomId, 4)).rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("uses only generated media routes, requests, grants, status views, and downloads", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(uploadGrant, 201))
      .mockResolvedValueOnce(json({ mediaId, state: "processing", enqueued: true }))
      .mockResolvedValueOnce(json(mediaView))
      .mockResolvedValueOnce(json({ downloadUrl: "https://storage.learning-orbit.test/download/signed", expiresAt: "2026-08-31T01:05:00.000Z" }));
    const gateway = new FetchSessionGateway({ fetch });
    const input = {
      kind: "image" as const,
      originalFileName: "pond.png",
      mime: "image/png",
      sizeBytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      altText: "池塘草圖",
      caption: null,
    };
    await expect(gateway.createMediaUpload(createdRoom.room.roomId, input)).resolves.toEqual(uploadGrant);
    await expect(gateway.completeMediaUpload(createdRoom.room.roomId, mediaId)).resolves.toEqual({ mediaId, state: "processing", enqueued: true });
    await expect(gateway.getMedia(createdRoom.room.roomId, mediaId)).resolves.toEqual(mediaView);
    await expect(gateway.getMediaDownloadGrant(createdRoom.room.roomId, mediaId)).resolves.toMatchObject({ downloadUrl: expect.stringMatching(/^https:/) });
    expect(fetch).toHaveBeenNthCalledWith(1, `/v1/rooms/${createdRoom.room.roomId}/media/uploads`, expect.objectContaining({ method: "POST", body: JSON.stringify(input), credentials: "include" }));
    expect(fetch).toHaveBeenNthCalledWith(2, `/v1/rooms/${createdRoom.room.roomId}/media/${mediaId}/complete`, expect.objectContaining({ method: "POST", body: "{}" }));
    expect(fetch).toHaveBeenNthCalledWith(3, `/v1/rooms/${createdRoom.room.roomId}/media/${mediaId}`, expect.objectContaining({ method: "GET" }));
    expect(fetch).toHaveBeenNthCalledWith(4, `/v1/rooms/${createdRoom.room.roomId}/media/${mediaId}/download`, expect.objectContaining({ method: "GET" }));
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ redirect: "error", credentials: "include" });

    const unavailable = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "MEDIA_SERVICE_UNAVAILABLE" }, 503)) });
    await expect(unavailable.createMediaUpload(createdRoom.room.roomId, input))
      .rejects.toEqual(new SessionGatewayError("MEDIA_SERVICE_UNAVAILABLE"));
    const leaked = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ ...uploadGrant, providerSecret: "no" }, 201)) });
    await expect(leaked.createMediaUpload(createdRoom.room.roomId, input)).rejects.toThrow("SESSION_RESPONSE_INVALID");
    const derivativePending = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "MEDIA_NOT_READY" }, 409)) });
    await expect(derivativePending.getMedia(createdRoom.room.roomId, mediaId))
      .rejects.toEqual(new SessionGatewayError("MEDIA_NOT_READY"));
  });

  it("loads only the generated room-owned Agent current state", async () => {
    const fetch = vi.fn().mockResolvedValue(json(agentCurrent));
    const controller = new AbortController();
    await expect(new FetchSessionGateway({ fetch }).getAgentCurrent(createdRoom.room.roomId, { signal: controller.signal })).resolves.toEqual(agentCurrent);
    expect(fetch).toHaveBeenCalledWith(
      `/v1/rooms/${createdRoom.room.roomId}/agent/current`,
      expect.objectContaining({ method: "GET", credentials: "include", cache: "no-store", redirect: "error", signal: controller.signal }),
    );
    const unavailable = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "AGENT_SERVICE_UNAVAILABLE" }, 503)) });
    await expect(unavailable.getAgentCurrent(createdRoom.room.roomId))
      .rejects.toEqual(new SessionGatewayError("AGENT_SERVICE_UNAVAILABLE"));
    const leaked = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ ...agentCurrent, provider: "fixture" })) });
    await expect(leaked.getAgentCurrent(createdRoom.room.roomId)).rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("updates the teacher Nova policy through the generated settings contract", async () => {
    const response = { enabled: false, cancelledRunId: null };
    const fetch = vi.fn().mockResolvedValue(json(response));
    const controller = new AbortController();
    await expect(new FetchSessionGateway({ fetch }).setAgentSettings(
      createdRoom.room.roomId,
      { enabled: false },
      { signal: controller.signal },
    )).resolves.toEqual(response);
    expect(fetch).toHaveBeenCalledWith(
      `/v1/rooms/${createdRoom.room.roomId}/agent/settings`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
        credentials: "include",
        signal: controller.signal,
      }),
    );

    const leaked = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ ...response, provider: "fixture" })) });
    await expect(leaked.setAgentSettings(createdRoom.room.roomId, { enabled: false }))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("loads a room-correlated generated teacher artifact page through the bounded shared route", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(json(artifactPage));
    await expect(new FetchSessionGateway({ fetch }).getDerivedTextArtifacts(
      createdRoom.room.roomId,
      { reviewStatus: "unreviewed", includeHistory: false, limit: 50 },
      { signal: controller.signal },
    )).resolves.toEqual(artifactPage);
    expect(fetch).toHaveBeenCalledWith(
      `/v1/rooms/${createdRoom.room.roomId}/analytics/artifacts?reviewStatus=unreviewed&limit=50`,
      expect.objectContaining({
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      }),
    );

    const wrongRoom = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({
      ...artifactPage,
      items: [{ ...derivedTextArtifact, roomId: "00000000-0000-4000-8000-000000000099" }],
    })) });
    await expect(wrongRoom.getDerivedTextArtifacts(createdRoom.room.roomId))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");

    const inconsistentCursor = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({
      ...artifactPage,
      nextAfterArtifactId: "00000000-0000-4000-8000-000000000a09",
    })) });
    await expect(inconsistentCursor.getDerivedTextArtifacts(createdRoom.room.roomId))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("submits the generated review branch and all seven correction branches without predicting a projection", async () => {
    for (const command of reviewCommands) {
      const changeKind = "correctionKind" in command ? "correction" as const : "review" as const;
      const accepted = { schemaVersion: 1 as const, reviewEventId, replayJobId, changeKind };
      const fetch = vi.fn().mockResolvedValue(json(accepted, 201));
      await expect(new FetchSessionGateway({ fetch }).submitAnalyticsReview(
        createdRoom.room.roomId,
        command,
      )).resolves.toEqual(accepted);
      expect(fetch).toHaveBeenCalledWith(
        `/v1/rooms/${createdRoom.room.roomId}/analytics/reviews`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(command),
          credentials: "include",
          cache: "no-store",
          redirect: "error",
        }),
      );
    }

    const mismatched = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({
      schemaVersion: 1,
      reviewEventId,
      replayJobId,
      changeKind: "review",
    }, 201)) });
    await expect(mismatched.submitAnalyticsReview(createdRoom.room.roomId, reviewCommands[1]))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("accepts the same generated response on a server-confirmed idempotent review retry", async () => {
    const accepted = { schemaVersion: 1 as const, reviewEventId, replayJobId, changeKind: "review" as const };
    const fetch = vi.fn().mockResolvedValue(json(accepted, 200));
    await expect(new FetchSessionGateway({ fetch }).submitAnalyticsReview(
      createdRoom.room.roomId,
      reviewCommands[0],
    )).resolves.toEqual(accepted);
  });

  it("loads only a generated review detail correlated to the requested room and event", async () => {
    const detail = {
      schemaVersion: 1 as const,
      reviewEventId,
      roomId: createdRoom.room.roomId,
      changeKind: "review" as const,
      payload: reviewCommands[0],
      createdAt: "2026-08-31T01:05:00.000Z",
    };
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(json(detail));
    await expect(new FetchSessionGateway({ fetch }).getAnalyticsReviewDetail(
      createdRoom.room.roomId,
      reviewEventId,
      { signal: controller.signal },
    )).resolves.toEqual(detail);
    expect(fetch).toHaveBeenCalledWith(
      `/v1/rooms/${createdRoom.room.roomId}/analytics/reviews/${reviewEventId}`,
      expect.objectContaining({ method: "GET", credentials: "include", signal: controller.signal }),
    );

    const wrongReview = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({
      ...detail,
      reviewEventId: "00000000-0000-4000-8000-000000000b09",
    })) });
    await expect(wrongReview.getAnalyticsReviewDetail(createdRoom.room.roomId, reviewEventId))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("requests deletion once with a generated confirmation and restores typed status by job or room", async () => {
    const controller = new AbortController();
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(deletionAccepted, 202))
      .mockResolvedValueOnce(json(deletionRunning))
      .mockResolvedValueOnce(json(deletionCompleted));
    const gateway = new FetchSessionGateway({ fetch });

    await expect(gateway.requestRoomDeletion(createdRoom.room.roomId, { signal: controller.signal }))
      .resolves.toEqual(deletionAccepted);
    await expect(gateway.getDeletionStatus(deletionJobId, { signal: controller.signal }))
      .resolves.toEqual(deletionRunning);
    await expect(gateway.getRoomDeletion(createdRoom.room.roomId, { signal: controller.signal }))
      .resolves.toEqual(deletionCompleted);

    expect(fetch).toHaveBeenNthCalledWith(1, `/v1/rooms/${createdRoom.room.roomId}`, expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ confirmation: `DELETE ${createdRoom.room.roomId}` }),
      credentials: "include",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    }));
    expect(fetch).toHaveBeenNthCalledWith(2, `/v1/deletions/${deletionJobId}`, expect.objectContaining({
      method: "GET",
      credentials: "include",
      signal: controller.signal,
    }));
    expect(fetch).toHaveBeenNthCalledWith(3, `/v1/rooms/${createdRoom.room.roomId}/deletion`, expect.objectContaining({
      method: "GET",
      credentials: "include",
      signal: controller.signal,
    }));

    const wrongJob = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({
      ...deletionRunning,
      deletionJobId: "00000000-0000-4000-8000-000000000c09",
    })) });
    await expect(wrongJob.getDeletionStatus(deletionJobId)).rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("fails closed on malformed deletion receipts and endpoint-illegal governance errors", async () => {
    const malformed = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({
      ...deletionCompleted,
      receipt: { ...deletionCompleted.receipt, surfacesVerified: ["events"] },
    })) });
    await expect(malformed.getRoomDeletion(createdRoom.room.roomId))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");

    const hidden = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "ROOM_NOT_FOUND" }, 404)) });
    await expect(hidden.getRoomDeletion(createdRoom.room.roomId))
      .rejects.toEqual(new SessionGatewayError("ROOM_NOT_FOUND"));
    const leaked = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "DELETION_STATUS_CORRUPT" }, 404)) });
    await expect(leaked.getRoomDeletion(createdRoom.room.roomId))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("returns a strictly validated JSON export Blob and a safe UTF-8 disposition filename", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(exported(
      JSON.stringify(exportDocument),
      "application/json; charset=utf-8",
      "attachment; filename*=UTF-8''ecosystem-export.json",
    ));
    const result = await new FetchSessionGateway({ fetch }).exportRoom(
      createdRoom.room.roomId,
      "json",
      { signal: controller.signal },
    );
    expect(result).toMatchObject({ fileName: "ecosystem-export.json", format: "json", blob: expect.any(Blob) });
    expect(result.blob.type).toBe("application/json");
    expect(await result.blob.text()).toBe(JSON.stringify(exportDocument));
    expect(fetch).toHaveBeenCalledWith(
      `/v1/rooms/${createdRoom.room.roomId}/export?format=json`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Accept: "application/json" }),
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      }),
    );
  });

  it("cancels an undeclared export stream as soon as its byte bound is exceeded", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123456"));
        controller.enqueue(new TextEncoder().encode("789"));
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } });

    await expect(readBoundedExportText(response, 8)).rejects.toThrow("SESSION_RESPONSE_INVALID");
    expect(cancelled).toBe(true);
  });

  it("validates CSV structure and replaces path or identifier-bearing filenames with a generic basename", async () => {
    for (const unsafeFileName of [
      "../../teacher-export.csv",
      `learning-orbit-${createdRoom.room.roomId.slice(0, 8)}-export.csv`,
    ]) {
      const fetch = vi.fn().mockResolvedValue(exported(
        exportCsv,
        "text/csv; charset=utf-8",
        `attachment; filename="${unsafeFileName}"`,
      ));
      const result = await new FetchSessionGateway({ fetch }).exportRoom(createdRoom.room.roomId, "csv");
      expect(result.fileName).toBe("learning-orbit-room-export.csv");
      expect(result.format).toBe("csv");
      expect(result.blob.type).toBe("text/csv");
      expect(await result.blob.text()).toBe(exportCsv);
    }
  });

  it("validates RFC 4180 quoted JSON records containing commas, quotes, and newlines", async () => {
    const messageEvent = {
      ...exportedEvent,
      type: "message.added",
      actorRole: "student",
      payload: {
        messageId: "00000000-0000-4000-8000-000000000d05",
        text: "觀察池塘,\n\"生產者\"吸收陽光。",
        replyTo: null,
        mentions: [],
        mediaIds: [],
      },
    };
    const csv = exportCsvHeader
      + csvJsonRow("manifest", {
        schemaVersion: 1,
        exportKind: "teacher_room",
        roomId: createdRoom.room.roomId,
        throughRoomSeq: 1,
      })
      + csvJsonRow("event", messageEvent);
    const gateway = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(exported(
      csv,
      "text/csv; charset=utf-8",
      "attachment; filename=ecosystem.csv",
    )) });

    const result = await gateway.exportRoom(createdRoom.room.roomId, "csv");
    expect(await result.blob.text()).toBe(csv);
  });

  it("fails closed on wrong export MIME, cross-room JSON, malformed CSV, or endpoint-illegal errors", async () => {
    const wrongMime = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(exported(
      JSON.stringify(exportDocument),
      "text/html",
      "attachment; filename=export.json",
    )) });
    await expect(wrongMime.exportRoom(createdRoom.room.roomId, "json"))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");

    const crossRoom = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(exported(
      JSON.stringify({
        ...exportDocument,
        roomId: "00000000-0000-4000-8000-000000000099",
      }),
      "application/json",
      "attachment; filename=export.json",
    )) });
    await expect(crossRoom.exportRoom(createdRoom.room.roomId, "json"))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");

    const malformedCsv = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(exported(
      exportCsv.replace(exportCsvHeader, "eventId,roomSeq,type\n"),
      "text/csv",
      "attachment; filename=export.csv",
    )) });
    await expect(malformedCsv.exportRoom(createdRoom.room.roomId, "csv"))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");

    const unavailable = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "EXPORT_UNAVAILABLE" }, 503)) });
    await expect(unavailable.exportRoom(createdRoom.room.roomId, "json"))
      .rejects.toEqual(new SessionGatewayError("EXPORT_UNAVAILABLE"));
    const illegal = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ code: "ANALYTICS_CORRUPT" }, 503)) });
    await expect(illegal.exportRoom(createdRoom.room.roomId, "json"))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("loads only room-and-key-correlated generated ECHO and TRACE snapshots", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(echoLatest))
      .mockResolvedValueOnce(json(traceLatest));
    const gateway = new FetchSessionGateway({ fetch });
    await expect(gateway.getProjectionLatest(createdRoom.room.roomId, "echo.student_approved"))
      .resolves.toEqual(echoLatest);
    await expect(gateway.getProjectionLatest(createdRoom.room.roomId, "trace.student_bundle"))
      .resolves.toEqual(traceLatest);
    expect(fetch).toHaveBeenNthCalledWith(1,
      `/v1/rooms/${createdRoom.room.roomId}/analytics/echo.student_approved/latest`,
      expect.objectContaining({ method: "GET", credentials: "include", cache: "no-store", redirect: "error" }),
    );
    expect(fetch).toHaveBeenNthCalledWith(2,
      `/v1/rooms/${createdRoom.room.roomId}/analytics/trace.student_bundle/latest`,
      expect.objectContaining({ method: "GET", credentials: "include", cache: "no-store", redirect: "error" }),
    );

    const wrongRoom = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json({ ...echoLatest, roomId: "00000000-0000-4000-8000-000000000099" })) });
    await expect(wrongRoom.getProjectionLatest(createdRoom.room.roomId, "echo.student_approved"))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
    const wrongBranch = new FetchSessionGateway({ fetch: vi.fn().mockResolvedValue(json(traceLatest)) });
    await expect(wrongBranch.getProjectionLatest(createdRoom.room.roomId, "echo.student_approved"))
      .rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("parses generated ECHO patch pages and validates a 409 resync URL exactly", async () => {
    const patchPage = {
      schemaVersion: 1 as const,
      roomId: createdRoom.room.roomId,
      projectionKey: "echo.student_approved" as const,
      analysisEpoch: analyticsEpoch,
      patches: [echoPatch],
    };
    const fetch = vi.fn().mockResolvedValue(json(patchPage));
    await expect(new FetchSessionGateway({ fetch }).getProjectionPatches(
      createdRoom.room.roomId,
      "echo.student_approved",
      { analysisEpoch: analyticsEpoch, afterProjectionVersion: 1 },
    )).resolves.toEqual(patchPage);
    expect(fetch).toHaveBeenCalledWith(
      `/v1/rooms/${createdRoom.room.roomId}/analytics/echo.student_approved/patches?analysisEpoch=${analyticsEpoch}&afterProjectionVersion=1`,
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );

    const canonical = `/v1/rooms/${createdRoom.room.roomId}/analytics/echo.student_approved/latest`;
    const resync = new FetchSessionGateway({
      fetch: vi.fn().mockResolvedValue(json({ code: "SNAPSHOT_RESYNC_REQUIRED", snapshotUrl: canonical }, 409)),
    });
    await expect(resync.getProjectionPatches(createdRoom.room.roomId, "echo.student_approved", {
      analysisEpoch: analyticsEpoch,
      afterProjectionVersion: 1,
    })).rejects.toEqual(new SessionGatewayError("SNAPSHOT_RESYNC_REQUIRED"));

    const hostile = new FetchSessionGateway({
      fetch: vi.fn().mockResolvedValue(json({
        code: "SNAPSHOT_RESYNC_REQUIRED",
        snapshotUrl: `${canonical}?leak=1`,
      }, 409)),
    });
    await expect(hostile.getProjectionPatches(createdRoom.room.roomId, "echo.student_approved", {
      analysisEpoch: analyticsEpoch,
      afterProjectionVersion: 1,
    })).rejects.toThrow("SESSION_RESPONSE_INVALID");
  });

  it("keeps per-key policy denial distinct and parses a generated ECHO timeline", async () => {
    const notPromoted = new FetchSessionGateway({
      fetch: vi.fn().mockResolvedValue(json({ code: "STUDENT_ANALYTICS_NOT_PROMOTED" }, 403)),
    });
    await expect(notPromoted.getProjectionLatest(createdRoom.room.roomId, "trace.student_bundle"))
      .rejects.toEqual(new SessionGatewayError("STUDENT_ANALYTICS_NOT_PROMOTED"));

    const timeline = {
      schemaVersion: 1 as const,
      roomId: createdRoom.room.roomId,
      projectionKey: "echo.student_approved" as const,
      analysisEpoch: analyticsEpoch,
      baseSnapshot: echoLatest,
      patches: [echoPatch],
      truncatedBeforeVersion: 1,
      headVersion: 2,
    };
    const fetch = vi.fn().mockResolvedValue(json(timeline));
    await expect(new FetchSessionGateway({ fetch }).getConceptTimeline(
      createdRoom.room.roomId,
      "echo.student_approved",
      { analysisEpoch: analyticsEpoch, limit: 200 },
    )).resolves.toEqual(timeline);
    expect(fetch).toHaveBeenCalledWith(
      `/v1/rooms/${createdRoom.room.roomId}/analytics/echo.student_approved/timeline?analysisEpoch=${analyticsEpoch}&limit=200`,
      expect.objectContaining({ method: "GET", credentials: "include", cache: "no-store" }),
    );
  });
});
