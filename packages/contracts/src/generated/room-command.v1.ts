/* generated; source is JSON Schema */

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
