type RoomEventQuery = { afterSeq?: number; limit?: number };

const ANALYTICS_PROJECTION_KEYS = new Set([
  "echo.teacher_shadow", "echo.student_approved",
  "trace.teacher_bundle", "trace.student_bundle",
]);
const ECHO_PROJECTION_KEYS = new Set(["echo.teacher_shadow", "echo.student_approved"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertCursor(value: number | undefined) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError("afterSeq");
  }
}

function assertLimit(value: number | undefined) {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 500)) {
    throw new RangeError("limit");
  }
}

function room(roomId: string, suffix = "") {
  return `/v1/rooms/${encodeURIComponent(roomId)}${suffix}`;
}

function roomEvents(roomId: string, query: RoomEventQuery = {}) {
  assertCursor(query.afterSeq);
  assertLimit(query.limit);

  const parameters = new URLSearchParams();
  if (query.afterSeq !== undefined) parameters.set("afterSeq", String(query.afterSeq));
  if (query.limit !== undefined) parameters.set("limit", String(query.limit));
  const suffix = parameters.size ? `?${parameters}` : "";
  return room(roomId, `/events${suffix}`);
}

function teacherMagicLinkConsume(token: string) {
  return `/v1/auth/teacher/magic-link/consume?token=${encodeURIComponent(token)}`;
}

function analyticsProjection(roomId: string, projectionKey: string, suffix: string): string {
  if (!ANALYTICS_PROJECTION_KEYS.has(projectionKey)) throw new RangeError("projectionKey");
  return room(roomId, `/analytics/${encodeURIComponent(projectionKey)}${suffix}`);
}

function analyticsQuery(roomId: string, query: {
  reviewStatus?: "unreviewed" | "approved" | "rejected" | "corrected";
  afterArtifactId?: string;
  includeHistory?: boolean;
  limit?: number;
}): string {
  if (query.reviewStatus !== undefined && !["unreviewed", "approved", "rejected", "corrected"].includes(query.reviewStatus)) throw new RangeError("reviewStatus");
  if (query.afterArtifactId !== undefined && !UUID.test(query.afterArtifactId)) throw new RangeError("afterArtifactId");
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100)) throw new RangeError("limit");
  const params = new URLSearchParams();
  if (query.reviewStatus !== undefined) params.set("reviewStatus", query.reviewStatus);
  if (query.afterArtifactId !== undefined) params.set("afterArtifactId", query.afterArtifactId);
  if (query.includeHistory === true) params.set("includeHistory", "true");
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const suffix = params.size ? `?${params.toString()}` : "";
  return room(roomId, `/analytics/artifacts${suffix}`);
}

function encodeQuery(query: Record<string, unknown>, order: readonly string[] = Object.keys(query).sort()): string {
  const params = new URLSearchParams();
  for (const key of order) {
    const value = query[key];
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

function analyticsEpoch(value: string): void {
  if (!UUID.test(value)) throw new RangeError("analysisEpoch");
}

function projectionVersion(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new RangeError("afterProjectionVersion");
}

export const routes = {
  auth: {
    session: () => "/v1/auth/session",
    teacherMagicLink: () => "/v1/auth/teacher/magic-link",
    teacherMagicLinkConsume,
  },
  rooms: {
    create: () => "/v1/rooms",
    join: () => "/v1/rooms/join",
    get: (roomId: string) => room(roomId),
    events: roomEvents,
    websocket: (roomId: string) => room(roomId, "/realtime"),
    open: (roomId: string) => room(roomId, "/open"),
    pause: (roomId: string) => room(roomId, "/pause"),
    resume: (roomId: string) => room(roomId, "/resume"),
    close: (roomId: string) => room(roomId, "/close"),
    delete: (roomId: string) => room(roomId),
    deletionStatus: (roomId: string) => room(roomId, "/deletion"),
    export: (roomId: string, format: "json" | "csv") => room(roomId, `/export?format=${format}`),
  },
  media: {
    upload: (roomId: string) => room(roomId, "/media/uploads"),
    get: (roomId: string, mediaId: string) => room(roomId, `/media/${encodeURIComponent(mediaId)}`),
    complete: (roomId: string, mediaId: string) => room(roomId, `/media/${encodeURIComponent(mediaId)}/complete`),
    download: (roomId: string, mediaId: string) => room(roomId, `/media/${encodeURIComponent(mediaId)}/download`),
  },
  agent: {
    request: (roomId: string) => room(roomId, "/agent/runs"),
    cancel: (roomId: string, agentRunId: string) => room(roomId, `/agent/runs/${encodeURIComponent(agentRunId)}/cancel`),
    current: (roomId: string) => room(roomId, "/agent/current"),
    settings: (roomId: string) => room(roomId, "/agent/settings"),
  },
  analytics: {
    artifacts: (roomId: string, query: { reviewStatus?: "unreviewed" | "approved" | "rejected" | "corrected"; afterArtifactId?: string; includeHistory?: boolean; limit?: number } = {}) => analyticsQuery(roomId, query),
    latest: (roomId: string, projectionKey: string) => analyticsProjection(roomId, projectionKey, "/latest"),
    patches: (roomId: string, projectionKey: string, query: { analysisEpoch: string; afterProjectionVersion?: number }) => { analyticsEpoch(query.analysisEpoch); projectionVersion(query.afterProjectionVersion); return analyticsProjection(roomId, projectionKey, `/patches?${encodeQuery(query, ["analysisEpoch", "afterProjectionVersion"])}`); },
    timeline: (roomId: string, projectionKey: "echo.teacher_shadow" | "echo.student_approved", query: { analysisEpoch: string; limit?: number }) => { if (!ECHO_PROJECTION_KEYS.has(projectionKey)) throw new RangeError("projectionKey"); analyticsEpoch(query.analysisEpoch); if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200)) throw new RangeError("limit"); return analyticsProjection(roomId, projectionKey, `/timeline?${encodeQuery(query, ["analysisEpoch", "limit"])}`); },
    reviews: (roomId: string) => room(roomId, "/analytics/reviews"),
    reviewDetail: (roomId: string, reviewEventId: string) => room(roomId, `/analytics/reviews/${encodeURIComponent(reviewEventId)}`),
  },
  deletions: {
    get: (deletionJobId: string) => `/v1/deletions/${encodeURIComponent(deletionJobId)}`,
    forRoom: (roomId: string) => room(roomId, "/deletion"),
  },
  internal: {
    rooms: {
      autoClose: () => "/internal/rooms/auto-close",
    },
    media: {
      reconcileUpload: () => "/internal/media/reconcile-upload",
    },
    agent: {
      health: () => "/internal/agent/provider-health",
    },
  },
} as const;
