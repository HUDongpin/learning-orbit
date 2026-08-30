/* generated; source is JSON Schema */

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
