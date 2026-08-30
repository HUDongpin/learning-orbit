type RoomEventQuery = { afterSeq?: number; limit?: number };

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
  },
  internal: {
    rooms: {
      autoClose: () => "/internal/rooms/auto-close",
    },
  },
} as const;
