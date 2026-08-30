/* generated; source is JSON Schema */

export type RealtimeFrame = ClientFrame | ServerFrame;
export type ClientFrame = ClientHello | ClientCommand | ClientPresence | ClientTyping | ClientHeartbeat;
export type U = string;
export type RoomCommand = {
  [k: string]: unknown;
} & {
  commandId: string;
  roomId: string;
  type:
    "room.open" | "room.pause" | "room.resume" | "room.close" | "message.add" | "message.revise" | "message.retract";
  clientTime: string;
  baseRevision?: number;
  payload: {
    [k: string]: unknown;
  };
};
export type ServerFrame =
  | ServerWelcome
  | ServerAck
  | ServerReject
  | ServerEvent
  | ServerPresence
  | ServerTyping
  | ServerResumeComplete
  | ServerSnapshotRequired
  | ServerDegraded
  | ServerHeartbeat
  | MediaStatusFrame
  | AgentStatusFrame
  | ProjectionFrame;
export type T = string;
export type Status = "scheduled" | "open" | "paused" | "closed";
export type RoomEventEnvelope = {
  eventId: string;
  schemaVersion: 1;
  roomId: string;
  roomSeq: number;
  type: string;
  actorId: string;
  actorKind: "human" | "agent" | "system";
  actorRole: "teacher" | "student" | "socratic_facilitator" | "room_clock" | "system_worker";
  revision: number;
  operation: "add" | "revise" | "retract";
  eventTime: string;
  ingestTime: string;
  causationId: string;
  correlationId: string;
  payload: {
    [k: string]: unknown;
  };
} & (
  | {
      actorKind: "human";
      actorRole: "teacher" | "student";
      [k: string]: unknown;
    }
  | {
      actorKind: "agent";
      actorRole: "socratic_facilitator";
      [k: string]: unknown;
    }
  | {
      actorKind: "system";
      actorRole: "room_clock" | "system_worker";
      [k: string]: unknown;
    }
);
export type ServerDegraded = {
  [k: string]: unknown;
} & {
  type: "degraded";
  scope: "realtime" | "media" | "analytics" | "agent";
  code: string;
  updatedAt: T;
  retryAfterMs?: number;
  projectionKey?: "echo.student_approved" | "trace.student_bundle";
};

export interface ClientHello {
  type: "hello";
  clientId: U;
  resumeFrom: number;
}
export interface ClientCommand {
  type: "command";
  command: RoomCommand;
}
export interface ClientPresence {
  type: "presence";
  state: "active" | "away";
  clientSeq: number;
}
export interface ClientTyping {
  type: "typing";
  active: boolean;
  clientSeq: number;
}
export interface ClientHeartbeat {
  type: "heartbeat";
}
export interface ServerWelcome {
  type: "welcome";
  serverTime: T;
  roomId: U;
  cursor: number;
  status: Status;
}
export interface ServerAck {
  type: "ack";
  commandId: U;
  roomSeq: number;
  revision: number;
}
export interface ServerReject {
  type: "reject";
  commandId?: U;
  code:
    | "AUTH_REQUIRED"
    | "FORBIDDEN"
    | "INVALID_COMMAND"
    | "ROOM_NOT_OPEN"
    | "MESSAGE_NOT_FOUND"
    | "REVISION_CONFLICT"
    | "RESYNC_REQUIRED"
    | "INTERNAL";
  retryable?: boolean;
}
export interface ServerEvent {
  type: "event";
  event: RoomEventEnvelope;
}
export interface ServerPresence {
  type: "presence";
  actorId: U;
  state: "active" | "away";
  expiresAt: T;
}
export interface ServerTyping {
  type: "typing";
  actorId: U;
  active: boolean;
  expiresAt: T;
}
export interface ServerResumeComplete {
  type: "resume_complete";
  throughRoomSeq: number;
}
export interface ServerSnapshotRequired {
  type: "snapshot_required";
  afterSeq: number;
  throughRoomSeq: number;
}
export interface ServerHeartbeat {
  type: "heartbeat";
  serverTime: T;
}
export interface MediaStatusFrame {
  type: "media_status";
  mediaId: string;
  state: "uploaded" | "processing" | "ready" | "quarantined" | "failed" | "deleted";
  failureCode: string | null;
  updatedAt: string;
}
export interface AgentStatusFrame {
  type: "agent_status";
  roomId: string;
  agentRunId: string | null;
  state: "idle" | "queued" | "running" | "streaming" | "completed" | "blocked_by_policy" | "cancelled" | "failed";
  serviceHealth: "healthy" | "degraded" | "unavailable";
  agentEnabled: boolean;
  updatedAt: string;
  failureCode: string | null;
}
export interface ProjectionFrame {
  type: "projection";
  roomId: U;
  projectionKey: "echo.teacher_shadow" | "echo.student_approved" | "trace.teacher_bundle" | "trace.student_bundle";
  analysisEpoch: U;
  projectionVersion: number;
  completeThroughRoomSeq: number;
  snapshotUrl: string;
}
