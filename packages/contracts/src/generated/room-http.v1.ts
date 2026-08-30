/* generated; source is JSON Schema */

/**
 * This interface was referenced by `RoomHttpCatalog`'s JSON-Schema
 * via the `definition` "u".
 */
export type U = string;
/**
 * This interface was referenced by `RoomHttpCatalog`'s JSON-Schema
 * via the `definition` "t".
 */
export type T = string | null;
/**
 * This interface was referenced by `RoomHttpCatalog`'s JSON-Schema
 * via the `definition` "code6".
 */
export type Code6 = string;
/**
 * This interface was referenced by `RoomHttpCatalog`'s JSON-Schema
 * via the `definition` "code10".
 */
export type Code10 = string;
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

export interface RoomHttpCatalog {}
/**
 * This interface was referenced by `RoomHttpCatalog`'s JSON-Schema
 * via the `definition` "nova".
 */
export interface Nova {
  actorId: U;
  actorKind: "agent";
  actorRole: "socratic_facilitator";
  displayName: "Nova Agent";
}
/**
 * This interface was referenced by `RoomHttpCatalog`'s JSON-Schema
 * via the `definition` "p".
 */
export interface P {
  actorId: U;
  pseudonym: string;
  actorKind: "human";
  actorRole: "student";
}
/**
 * This interface was referenced by `RoomHttpCatalog`'s JSON-Schema
 * via the `definition` "CreateRoomRequest".
 */
export interface CreateRoomRequest {
  topic: string;
}
/**
 * This interface was referenced by `RoomHttpCatalog`'s JSON-Schema
 * via the `definition` "CreateRoomResponse".
 */
export interface CreateRoomResponse {
  room: {
    roomId: U;
    roomCode: Code6;
    status: "scheduled";
    durationSeconds: 2700;
    nova: Nova;
  };
  /**
   * @minItems 4
   * @maxItems 4
   */
  seatInvites: [
    {
      roomMemberId: U;
      actorId: U;
      pseudonym: string;
      code: Code10;
    },
    {
      roomMemberId: U;
      actorId: U;
      pseudonym: string;
      code: Code10;
    },
    {
      roomMemberId: U;
      actorId: U;
      pseudonym: string;
      code: Code10;
    },
    {
      roomMemberId: U;
      actorId: U;
      pseudonym: string;
      code: Code10;
    }
  ];
}
/**
 * This interface was referenced by `RoomHttpCatalog`'s JSON-Schema
 * via the `definition` "JoinRoomRequest".
 */
export interface JoinRoomRequest {
  roomCode: Code6;
  seatCode: Code10;
}
/**
 * This interface was referenced by `RoomHttpCatalog`'s JSON-Schema
 * via the `definition` "JoinRoomResponse".
 */
export interface JoinRoomResponse {
  roomMemberId: U;
  actorId: U;
  pseudonym: string;
}
/**
 * This interface was referenced by `RoomHttpCatalog`'s JSON-Schema
 * via the `definition` "RoomDetails".
 */
export interface RoomDetails {
  roomId: U;
  topic: string;
  status: "scheduled" | "open" | "paused" | "closed";
  durationSeconds: 2700;
  startsAt: T;
  closesAt: T;
  nova: Nova;
  /**
   * @minItems 4
   * @maxItems 4
   */
  participants: [P, P, P, P];
}
/**
 * This interface was referenced by `RoomHttpCatalog`'s JSON-Schema
 * via the `definition` "RoomEventPage".
 */
export interface RoomEventPage {
  /**
   * @maxItems 500
   */
  events: RoomEventEnvelope[];
  throughRoomSeq: number;
  nextAfterSeq?: number;
}
