import { describe, expect, it, vi } from "vitest";

import {
  FetchSessionGateway,
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
