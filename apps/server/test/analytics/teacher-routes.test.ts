import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  analyticsContract,
  analyticsTeacherHttpContract,
  type AuthSession,
} from "@learning-orbit/contracts";
import { buildApp } from "../../src/app.js";
import { AnalyticsTeacherError } from "../../src/modules/analytics/analytics-teacher-service.js";

const ORIGIN = "https://app.learning-orbit.test";
const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const TEACHER_ID = "00000000-0000-4000-8000-000000000011";
const SESSION_ID = "00000000-0000-4000-8000-000000000012";
const REVIEW_ID = "00000000-0000-4000-8000-000000000013";
const REPLAY_ID = "00000000-0000-4000-8000-000000000014";
const EPOCH = "00000000-0000-4000-8000-000000000015";
const teacher: Extract<AuthSession, { role: "teacher" }> = {
  role: "teacher",
  teacherId: TEACHER_ID,
  actorId: TEACHER_ID,
};
const reviewCommand = {
  targetType: "derived_text",
  targetId: "00000000-0000-4000-8000-000000000016",
  decision: "approve",
  rationale: "證據來源與文字一致。",
  expectedAnalysisEpoch: EPOCH,
  expectedProjectionVersion: 3,
} as const;

describe("teacher analytics HTTP boundary", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  async function appFor(overrides: Partial<{
    authorize: ReturnType<typeof vi.fn>;
    listArtifacts: ReturnType<typeof vi.fn>;
    review: ReturnType<typeof vi.fn>;
    reviewDetail: ReturnType<typeof vi.fn>;
  }> = {}) {
    const service = {
      authorize: overrides.authorize ?? vi.fn(async () => undefined),
      listArtifacts: overrides.listArtifacts ?? vi.fn(async () => ({
        items: [], throughRoomSeq: 0, nextAfterArtifactId: null, includeHistory: false,
      })),
      review: overrides.review ?? vi.fn(async () => ({
        schemaVersion: 1, reviewEventId: REVIEW_ID, changeKind: "review", replayJobId: REPLAY_ID, created: true,
      })),
      reviewDetail: overrides.reviewDetail ?? vi.fn(async () => ({
        schemaVersion: 1,
        reviewEventId: REVIEW_ID,
        roomId: ROOM_ID,
        changeKind: "review",
        payload: reviewCommand,
        createdAt: "2026-08-31T01:00:00.000Z",
      })),
    };
    const sessions = {
      get: vi.fn(async () => teacher),
      getSessionId: vi.fn(async () => SESSION_ID),
      revoke: vi.fn(async () => undefined),
    };
    const app = await buildApp({
      config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN },
      sessions: sessions as never,
      analyticsTeacher: service as never,
    });
    apps.push(app);
    return { app, service, sessions };
  }

  it("passes the raw artifact query to the guarded service and encodes the generated page", async () => {
    const { app, service } = await appFor();
    const response = await app.inject({
      method: "GET",
      url: `/v1/rooms/${ROOM_ID}/analytics/artifacts?reviewStatus=unreviewed&limit=50`,
      headers: { origin: ORIGIN },
      cookies: { lo_session: "opaque" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(analyticsContract.parseArtifactPage(response.json())).toEqual({
      items: [], throughRoomSeq: 0, nextAfterArtifactId: null, includeHistory: false,
    });
    expect(service.listArtifacts).toHaveBeenCalledWith(
      teacher,
      SESSION_ID,
      ROOM_ID,
      { reviewStatus: "unreviewed", limit: "50" },
    );
  });

  it("encodes closed acceptance and teacher-only review detail without reviewer identity", async () => {
    const { app, service } = await appFor();
    const accepted = await app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM_ID}/analytics/reviews`,
      headers: { origin: ORIGIN },
      cookies: { lo_session: "opaque" },
      payload: reviewCommand,
    });
    const detail = await app.inject({
      method: "GET",
      url: `/v1/rooms/${ROOM_ID}/analytics/reviews/${REVIEW_ID}`,
      headers: { origin: ORIGIN },
      cookies: { lo_session: "opaque" },
    });

    expect(accepted.statusCode).toBe(201);
    expect(accepted.headers["cache-control"]).toBe("no-store");
    expect(analyticsTeacherHttpContract.parseAccepted(accepted.json())).toMatchObject({
      reviewEventId: REVIEW_ID,
      replayJobId: REPLAY_ID,
    });
    expect(service.review).toHaveBeenCalledWith(teacher, SESSION_ID, ROOM_ID, reviewCommand);
    expect(detail.statusCode).toBe(200);
    expect(detail.headers["cache-control"]).toBe("no-store");
    expect(analyticsTeacherHttpContract.parseDetail(detail.json()).payload).toEqual(reviewCommand);
    expect(detail.body).not.toContain(TEACHER_ID);
  });

  it("returns 200 for a server-confirmed idempotent review retry without widening the response", async () => {
    const review = vi.fn(async () => ({
      schemaVersion: 1 as const,
      reviewEventId: REVIEW_ID,
      changeKind: "review" as const,
      replayJobId: REPLAY_ID,
      created: false,
    }));
    const { app } = await appFor({ review });
    const response = await app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM_ID}/analytics/reviews`,
      headers: { origin: ORIGIN },
      cookies: { lo_session: "opaque" },
      payload: reviewCommand,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(analyticsTeacherHttpContract.parseAccepted(response.json())).toMatchObject({ reviewEventId: REVIEW_ID });
    expect(response.json()).not.toHaveProperty("created");
  });

  it("keeps guarded failures content-free and no-store", async () => {
    const failure = vi.fn(async () => {
      throw new AnalyticsTeacherError(404, "ROOM_NOT_FOUND");
    });
    const { app } = await appFor({ listArtifacts: failure, review: failure, reviewDetail: failure });
    const requests = [
      { method: "GET" as const, url: `/v1/rooms/${ROOM_ID}/analytics/artifacts?reviewStatus%5B%5D=unreviewed` },
      { method: "POST" as const, url: `/v1/rooms/${ROOM_ID}/analytics/reviews`, payload: { secret: "must-not-return" } },
      { method: "GET" as const, url: `/v1/rooms/${ROOM_ID}/analytics/reviews/not-a-uuid` },
    ];
    for (const request of requests) {
      const response = await app.inject({
        ...request,
        headers: { origin: ORIGIN },
        cookies: { lo_session: "opaque" },
      });
      expect([response.statusCode, response.json()]).toEqual([404, { code: "ROOM_NOT_FOUND" }]);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("must-not-return");
    }
  });

  it("authenticates before Fastify parses an anonymous malformed review body", async () => {
    const review = vi.fn();
    const service = {
      authorize: vi.fn(),
      listArtifacts: vi.fn(),
      review,
      reviewDetail: vi.fn(),
    };
    const sessions = {
      get: vi.fn(async () => null),
      getSessionId: vi.fn(async () => null),
      revoke: vi.fn(async () => undefined),
    };
    const app = await buildApp({
      config: { allowedOrigins: [ORIGIN], publicBaseOrigin: ORIGIN },
      sessions: sessions as never,
      analyticsTeacher: service as never,
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: `/v1/rooms/${ROOM_ID}/analytics/reviews`,
      headers: { origin: ORIGIN, "content-type": "application/json" },
      payload: '{"broken":',
    });

    expect([response.statusCode, response.json()]).toEqual([401, { code: "AUTH_REQUIRED" }]);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(review).not.toHaveBeenCalled();
  });

  it("returns a stable parser code only after teacher-room authorization", async () => {
    const authorized = await appFor();
    const malformed = {
      method: "POST" as const,
      url: `/v1/rooms/${ROOM_ID}/analytics/reviews`,
      headers: { origin: ORIGIN, "content-type": "application/json" },
      cookies: { lo_session: "opaque" },
      payload: '{"broken":',
    };
    const parsed = await authorized.app.inject(malformed);
    expect([parsed.statusCode, parsed.json()]).toEqual([
      400,
      { code: "INVALID_ANALYTICS_REVIEW_COMMAND" },
    ]);
    expect(authorized.service.review).not.toHaveBeenCalled();

    const hidden = await appFor({ authorize: vi.fn(async () => {
      throw new AnalyticsTeacherError(404, "ROOM_NOT_FOUND");
    }) });
    const denied = await hidden.app.inject(malformed);
    expect([denied.statusCode, denied.json()]).toEqual([404, { code: "ROOM_NOT_FOUND" }]);
    expect(hidden.service.review).not.toHaveBeenCalled();
  });
});
