export type SessionStatus = "scheduled" | "open" | "paused" | "closed";

export type SessionState = {
  roomId: string;
  status: SessionStatus;
  connected: boolean;
  paused: boolean;
  startsAt: string | null;
  closesAt: string | null;
  lastRoomSeq: number;
  liveAnnouncement: string;
};

export type SessionAction =
  | { type: "connection"; connected: boolean }
  | { type: "status"; status: SessionStatus }
  | { type: "cursor"; roomSeq: number }
  | { type: "timing"; startsAt: string | null; closesAt: string | null }
  | { type: "announcement"; message: string }
  | { type: "reset" };

export function createSessionState(
  roomId: string,
  status: SessionStatus = "scheduled",
  startsAt: string | null = null,
  closesAt: string | null = null,
): SessionState {
  return { roomId, status, connected: false, paused: status === "paused", startsAt, closesAt, lastRoomSeq: 0, liveAnnouncement: "" };
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "connection":
      return { ...state, connected: action.connected };
    case "status":
      return { ...state, status: action.status, paused: action.status === "paused" };
    case "cursor":
      return action.roomSeq >= state.lastRoomSeq ? { ...state, lastRoomSeq: action.roomSeq } : state;
    case "timing":
      return { ...state, startsAt: action.startsAt, closesAt: action.closesAt };
    case "announcement":
      return { ...state, liveAnnouncement: action.message };
    case "reset":
      return createSessionState(state.roomId);
  }
}
