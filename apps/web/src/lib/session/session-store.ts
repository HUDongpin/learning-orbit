export type SessionStatus = "scheduled" | "open" | "paused" | "closed";

export type SessionState = {
  roomId: string;
  status: SessionStatus;
  connected: boolean;
  paused: boolean;
  lastRoomSeq: number;
  liveAnnouncement: string;
};

export type SessionAction =
  | { type: "connection"; connected: boolean }
  | { type: "status"; status: SessionStatus }
  | { type: "cursor"; roomSeq: number }
  | { type: "announcement"; message: string }
  | { type: "reset" };

export function createSessionState(roomId: string): SessionState {
  return { roomId, status: "open", connected: false, paused: false, lastRoomSeq: 0, liveAnnouncement: "" };
}

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "connection":
      return { ...state, connected: action.connected };
    case "status":
      return { ...state, status: action.status, paused: action.status === "paused" };
    case "cursor":
      return action.roomSeq >= state.lastRoomSeq ? { ...state, lastRoomSeq: action.roomSeq } : state;
    case "announcement":
      return { ...state, liveAnnouncement: action.message };
    case "reset":
      return createSessionState(state.roomId);
  }
}
