/**
 * Browser-facing re-export of the versioned contracts. Keeping imports here
 * gives the UI one seam when the transport package adds a new revision.
 */
export type {
  ClientFrame,
  MediaAttachmentView,
  MediaStatusFrame,
  RealtimeFrame,
  RoomCommand,
  RoomEventEnvelope,
  ServerFrame,
  ServerPresence,
  ServerTyping,
} from "@learning-orbit/contracts";

export { parseCoreRoomEvent, realtimeContract } from "@learning-orbit/contracts";
