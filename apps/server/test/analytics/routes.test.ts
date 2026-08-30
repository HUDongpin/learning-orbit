import { afterEach, describe, expect, it, vi } from "vitest";

import { analyticsContract, analyticsHttpContract, type AuthSession } from "@learning-orbit/contracts";
import { buildApp } from "../../src/app.js";

const ORIGIN = "https://app.learning-orbit.test";
const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const EPOCH = "00000000-0000-4000-8000-000000000901";
const SESSION_ID = "00000000-0000-4000-8000-000000000777";
const student: Extract<AuthSession, { role: "student" }> = {
  role: "student",
  roomId: ROOM_ID,
  roomMemberId: "00000000-0000-4000-8000-000000000011",
  actorId: "00000000-0000-4000-8000-000000000012",
  pseudonym: "探索者 A",
  nova: { actorId: "00000000-0000-4000-8000-000000000013", actorKind: "agent", actorRole: "socratic_facilitator", displayName: "Nova Agent" },
};

const snapshotRow = {
  schemaVersion: 1 as const,
  roomId: ROOM_ID,
  projectionKey: "echo.student_approved" as const,
  analysisEpoch: EPOCH,
  version: 1,
  baseVersion: 0,
  completeThroughRoomSeq: 4,
  watermarkEventTime: "2026-08-31T01:00:00.000Z",
  algorithmVersion: "echo-v1",
  parameterHash: "b".repeat(64),
  requiresReplay: false,
  evidenceStatus: "active" as const,
  reviewStatus: "unreviewed" as const,
  displayStatus: "student_approved" as const,
  warnings: ["client_time_future_clamped"],
  payload: { nodes: [], edges: [] },
  createdAt: "2026-08-31T01:00:00.000Z",
};
const patchRow = {
  ...snapshotRow,
  version: 2,
  baseVersion: 1,
  completeThroughRoomSeq: 5,
  payload: {
    requiresReplay: false,
    warnings: [], nodesAdded: [], nodesUpdated: [], nodesHidden: [],
    edgesAdded: [], edgesUpdated: [], edgesHidden: [], positionUpdates: [],
    changeScore: 0, reasonCodes: [],
  },
};

describe("public analytics route boundary", () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  async function appFor(repository: Record<string, unknown>) {
    const sessions = {
      get: vi.fn(async () => student),
      getSessionId: vi.fn(async () => SESSION_ID),
      revoke: vi.fn(async () => undefined),
    };
    const policy = {
      requireRoomAccess: vi.fn(async () => ({ roomId: ROOM_ID, role: "student" as const, studentProjectionAllowlist: new Set(["echo.student_approved", "trace.student_bundle"]) })),
      assertProjection: vi.fn(),
    };
    const app = await buildApp({
      config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN },
      sessions: sessions as never,
      analytics: { policy, repository } as never,
    });
    apps.push(app);
    return { app, sessions, policy };
  }

  it("encodes latest, patch page, timeline, and resync with no-store", async () => {
    const repository = {
      latest: vi.fn(async () => snapshotRow),
      patchesAfter: vi.fn()
        .mockResolvedValueOnce({ kind: "patches", patches: [patchRow] })
        .mockResolvedValueOnce({ kind: "resync" }),
      timeline: vi.fn(async () => ({
        kind: "timeline", baseSnapshot: snapshotRow, patches: [patchRow],
        truncatedBeforeVersion: 1, headVersion: 2,
      })),
    };
    const { app } = await appFor(repository);
    const urls = [
      `/v1/rooms/${ROOM_ID}/analytics/echo.student_approved/latest`,
      `/v1/rooms/${ROOM_ID}/analytics/echo.student_approved/patches?analysisEpoch=${EPOCH}&afterProjectionVersion=1`,
      `/v1/rooms/${ROOM_ID}/analytics/echo.student_approved/timeline?analysisEpoch=${EPOCH}&limit=200`,
      `/v1/rooms/${ROOM_ID}/analytics/trace.student_bundle/patches?analysisEpoch=${EPOCH}&afterProjectionVersion=1`,
    ];
    const responses = [];
    for (const url of urls) responses.push(await app.inject({ method: "GET", url, headers: { origin: ORIGIN }, cookies: { lo_session: "opaque" } }));

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200, 200, 409]);
    for (const response of responses) expect(response.headers["cache-control"]).toBe("no-store");
    expect(analyticsContract.parseEchoSnapshot(responses[0]!.json())).toMatchObject({
      projectionKey: "echo.student_approved",
      warnings: ["client_time_future_clamped"],
    });
    expect(analyticsHttpContract.parsePatchPage(responses[1]!.json()).patches).toHaveLength(1);
    expect(analyticsHttpContract.parseTimeline(responses[2]!.json())).toMatchObject({ headVersion: 2 });
    expect(analyticsHttpContract.parseResync(responses[3]!.json())).toEqual({
      code: "SNAPSHOT_RESYNC_REQUIRED",
      snapshotUrl: `/v1/rooms/${ROOM_ID}/analytics/trace.student_bundle/latest`,
    });
  });

  it("authenticates before parsing an analytics query and keeps failures content-free", async () => {
    const { app, sessions, policy } = await appFor({ latest: vi.fn(), patchesAfter: vi.fn(), timeline: vi.fn() });
    const response = await app.inject({
      method: "GET",
      url: `/v1/rooms/${ROOM_ID}/analytics/echo.student_approved/latest?token=secret`,
      headers: { origin: ORIGIN },
      cookies: { lo_session: "opaque" },
    });
    expect([response.statusCode, response.json()]).toEqual([400, { code: "INVALID_ANALYTICS_QUERY" }]);
    expect(sessions.get).toHaveBeenCalledBefore(policy.requireRoomAccess as never);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("secret");
  });
});
