/* generated; source is JSON Schema */

/**
 * This interface was referenced by `CoreRoomEventPayloadCatalog`'s JSON-Schema
 * via the `definition` "u".
 */
export type U = string;
/**
 * This interface was referenced by `CoreRoomEventPayloadCatalog`'s JSON-Schema
 * via the `definition` "t".
 */
export type T = string;
/**
 * @maxItems 5
 *
 * This interface was referenced by `CoreRoomEventPayloadCatalog`'s JSON-Schema
 * via the `definition` "m".
 */
export type M = [] | [U] | [U, U] | [U, U, U] | [U, U, U, U] | [U, U, U, U, U];
/**
 * @maxItems 4
 *
 * This interface was referenced by `CoreRoomEventPayloadCatalog`'s JSON-Schema
 * via the `definition` "ids".
 */
export type Ids = [] | [U] | [U, U] | [U, U, U] | [U, U, U, U];

export interface CoreRoomEventPayloadCatalog {}
/**
 * This interface was referenced by `CoreRoomEventPayloadCatalog`'s JSON-Schema
 * via the `definition` "RoomOpenedPayload".
 */
export interface RoomOpenedPayload {
  startsAt: T;
  closesAt: T;
}
/**
 * This interface was referenced by `CoreRoomEventPayloadCatalog`'s JSON-Schema
 * via the `definition` "RoomPausedPayload".
 */
export interface RoomPausedPayload {
  pausedAt: T;
}
/**
 * This interface was referenced by `CoreRoomEventPayloadCatalog`'s JSON-Schema
 * via the `definition` "RoomResumedPayload".
 */
export interface RoomResumedPayload {
  resumedAt: T;
}
/**
 * This interface was referenced by `CoreRoomEventPayloadCatalog`'s JSON-Schema
 * via the `definition` "RoomClosedPayload".
 */
export interface RoomClosedPayload {
  closedAt: T;
}
/**
 * This interface was referenced by `CoreRoomEventPayloadCatalog`'s JSON-Schema
 * via the `definition` "MessageAddedPayload".
 */
export interface MessageAddedPayload {
  messageId: U;
  text: string;
  replyTo: string | null;
  mentions: M;
  mediaIds: Ids;
  agentRunId?: U;
  /**
   * @maxItems 30
   */
  sourceEventIds?: U[];
  /**
   * @maxItems 20
   */
  warningCodes?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string
      ];
}
/**
 * This interface was referenced by `CoreRoomEventPayloadCatalog`'s JSON-Schema
 * via the `definition` "MessageRevisedPayload".
 */
export interface MessageRevisedPayload {
  messageId: U;
  text: string;
  replyTo: string | null;
  mentions: M;
  mediaIds: Ids;
}
/**
 * This interface was referenced by `CoreRoomEventPayloadCatalog`'s JSON-Schema
 * via the `definition` "MessageRetractedPayload".
 */
export interface MessageRetractedPayload {
  messageId: U;
}
