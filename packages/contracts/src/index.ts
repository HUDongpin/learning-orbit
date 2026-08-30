export { EventPayloadRegistry, createCoreEventPayloadRegistry } from "./event-payload-registry.js";
export { parseCoreRoomEvent, parseRoomEventEnvelope } from "./core-room-event.js";
export type { CoreRoomEvent } from "./core-room-event.js";
export { routes } from "./routes.js";
export { realtimeContract } from "./realtime.js";
export { makeSchemaAjv } from "./schema-ajv.js";
export { authContract } from "./auth.js";
export { apiErrorContract } from "./api-error.js";
export { roomHttpContract } from "./room.js";
export { teacherRoomListContract } from "./teacher-room-list.js";
export { roomInternalAutoCloseContract } from "./room-internal-auto-close.js";
export { mediaAttachmentContract } from "./media-attachment.js";
export { mediaCommandContract } from "./media-command.js";
export { mediaStatusContract } from "./media-status.js";
export { mediaInternalReconcileContract } from "./media-internal-reconcile.js";
export { agentContract } from "./agent.js";
export { analyticsContract, analyticsHttpContract, analyticsReviewRoomEventPayloadSchema } from "./analytics.js";
export type {
  DerivedTextArtifact,
  DerivedTextArtifactPage,
  AnalysisProjectionEnvelope,
  ConceptMapPatch,
  ConceptMapSnapshot,
  StudentConceptMapPatch,
  StudentConceptMapSnapshot,
  TeacherConceptMapPatch,
  TeacherConceptMapSnapshot,
  SnaProjectionBundle,
  AnalyticsPatchPage,
  StudentAnalyticsPatchPage,
  TeacherAnalyticsPatchPage,
  AnalyticsTimelineResponse,
  StudentAnalyticsTimelineResponse,
  TeacherAnalyticsTimelineResponse,
  AnalyticsResyncResponse,
} from "./analytics.js";
export {
  deletionLifecycleContract,
  parseDeletionReceipt,
  pilotRetentionPolicyContract,
  providerCopyAuthorityContract,
} from "./governance.js";
export type {
  PilotRetentionPolicyRecord,
  ProviderCopyAuthorityRecord,
  DeleteRoomRequest,
  DeleteRoomAccepted,
  DeletionStatus,
  DeletionReceipt,
} from "./governance.js";
export type { AuthSession } from "./generated/auth-session.v1.js";
export type { ApiError } from "./generated/api-error.v1.js";
export type { TeacherMagicLinkAccepted, TeacherMagicLinkRequest } from "./generated/auth-http.v1.js";
export type { CreateRoomRequest, CreateRoomResponse, JoinRoomRequest, JoinRoomResponse, RoomDetails, RoomEventPage } from "./generated/room-http.v1.js";
export type { TeacherRoomListResponse } from "./generated/teacher-room-list.v1.js";
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
export type {
  Request as RoomInternalAutoCloseRequest,
  Response as RoomInternalAutoCloseResponse,
} from "./generated/room-internal-auto-close.v1.js";
export type {
  ClientFrame,
  RealtimeFrame,
  ServerFrame,
  ServerPresence,
  ServerTyping,
  Status,
  ProjectionFrame,
} from "./generated/realtime-frame.v1.js";
export type { MediaAttachmentView } from "./generated/media-attachment-view.v1.js";
export type {
  CompleteMediaUploadResponse,
  CreateMediaUploadInput,
  MediaDownloadGrant,
  MediaUploadGrant,
} from "./generated/media-command.schema.js";
export type { MediaStatusFrame } from "./generated/media-status.v1.js";
export type { AgentStatusFrame } from "./generated/agent-status.v1.js";
export type { AgentCurrentState } from "./generated/agent-current-state.v1.js";
export type { AgentRun } from "./generated/agent-run.schema.js";
export type {
  AgentRunAccepted, CancelAgentRunAccepted, AgentSettingsInput, AgentSettingsResponse,
  RequestAgentRunInput, CancelAgentRunInput,
} from "./generated/agent-command.v1.js";
export type { Request as AgentProviderHealthRequest, Response as AgentProviderHealthResponse } from "./generated/agent-provider-health.v1.js";
export type {
  Request as MediaInternalReconcileRequest,
  Response as MediaInternalReconcileResponse,
} from "./generated/media-internal-reconcile.v1.js";
