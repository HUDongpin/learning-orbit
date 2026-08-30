type RoomEventQuery = { afterSeq?: number; limit?: number };

function assertCursor(value: number | undefined) {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new Error("INVALID_CURSOR");
  }
}

function assertLimit(value: number | undefined) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 500)) {
    throw new Error("INVALID_LIMIT");
  }
}

function roomEvents(roomId: string, query: RoomEventQuery = {}) {
  assertCursor(query.afterSeq);
  assertLimit(query.limit);

  const parameters = new URLSearchParams();
  if (query.afterSeq !== undefined) parameters.set("afterSeq", String(query.afterSeq));
  if (query.limit !== undefined) parameters.set("limit", String(query.limit));
  const suffix = parameters.size ? `?${parameters}` : "";
  return `/rooms/${encodeURIComponent(roomId)}/events${suffix}`;
}

export const routes = { rooms: { events: roomEvents } };
