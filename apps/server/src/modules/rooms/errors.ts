export type RoomErrorCode =
  | "FORBIDDEN"
  | "INVALID_COMMAND"
  | "ROOM_DELETION_IN_PROGRESS"
  | "ROOM_NOT_OPEN"
  | "MESSAGE_NOT_FOUND"
  | "REVISION_CONFLICT";

export class RoomError extends Error {
  override readonly name = "RoomError";

  constructor(readonly code: RoomErrorCode, readonly currentRevision?: number) {
    super(code);
  }
}
