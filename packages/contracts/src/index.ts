export { EventPayloadRegistry, createCoreEventPayloadRegistry } from "./event-payload-registry.js";
export { parseCoreRoomEvent, parseRoomEventEnvelope } from "./core-room-event.js";
export type { CoreRoomEvent } from "./core-room-event.js";
export { routes } from "./routes.js";
export { realtimeContract } from "./realtime.js";
export { makeSchemaAjv } from "./schema-ajv.js";
export { authContract } from "./auth.js";
export { roomHttpContract } from "./room.js";
export type { AuthSession } from "./generated/auth-session.v1.js";
export type { TeacherMagicLinkAccepted, TeacherMagicLinkRequest } from "./generated/auth-http.v1.js";
export type { CreateRoomRequest, CreateRoomResponse, JoinRoomRequest, JoinRoomResponse, RoomDetails, RoomEventPage } from "./generated/room-http.v1.js";
export type {
  MessageAddedPayload,
  MessageRetractedPayload,
  MessageRevisedPayload,
  RoomClosedPayload,
  RoomOpenedPayload,
  RoomPausedPayload,
  RoomResumedPayload,
} from "./generated/core-room-event-payloads.v1.js";
export type { RoomCommand } from "./generated/room-command.v1.js";
export type { RoomEventEnvelope } from "./generated/room-event-envelope.v1.js";
export type { ClientFrame, RealtimeFrame, ServerFrame } from "./generated/realtime-frame.v1.js";
