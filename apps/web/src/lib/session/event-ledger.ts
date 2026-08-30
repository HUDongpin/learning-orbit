import { realtimeContract, type RoomEventEnvelope } from "../contracts";

export type LedgerAppendResult = "appended" | "duplicate" | "stale" | "gap";

export type LedgerMessage = {
  messageId: string;
  text: string;
  actorId: string;
  actorKind: RoomEventEnvelope["actorKind"];
  actorRole: RoomEventEnvelope["actorRole"];
  eventId: string;
  revision: number;
  operation: RoomEventEnvelope["operation"];
  eventTime: string;
  firstRoomSeq: number;
  roomSeq: number;
  replyTo: string | null;
  mentions: string[];
  mediaIds: string[];
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** An at-least-once, revision-aware client ledger for durable room events. */
export class EventLedger {
  #events = new Map<string, RoomEventEnvelope>();
  #messages = new Map<string, LedgerMessage>();
  #lastSeq = 0;
  #roomId: string | undefined;

  constructor(roomId?: string) { this.#roomId = roomId; }

  get lastRoomSeq(): number {
    return this.#lastSeq;
  }

  append(value: unknown): LedgerAppendResult {
    const frame = realtimeContract.parseServerFrame({ type: "event", event: value });
    if (frame.type !== "event") throw new Error("ROOM_EVENT_REQUIRED");
    const event = frame.event;
    if (this.#roomId !== undefined && event.roomId !== this.#roomId) {
      throw new Error("ROOM_EVENT_ROOM_MISMATCH");
    }
    if (this.#events.has(event.eventId)) return "duplicate";
    if (event.roomSeq <= this.#lastSeq) return "stale";
    if (event.roomSeq !== this.#lastSeq + 1) return "gap";
    this.#events.set(event.eventId, event);
    this.#lastSeq = event.roomSeq;
    const payload = event.payload;
    const isMessageEvent = event.type === "message.added"
      || event.type === "message.revised"
      || event.type === "message.retracted";
    const messageId = stringValue(payload.messageId);
    if (isMessageEvent && messageId) {
      const previous = this.#messages.get(messageId);
      if (!previous || event.revision >= previous.revision) {
        this.#messages.set(messageId, {
          messageId,
          text: stringValue(payload.text) ?? "",
          actorId: previous?.actorId ?? event.actorId,
          actorKind: previous?.actorKind ?? event.actorKind,
          actorRole: previous?.actorRole ?? event.actorRole,
          eventId: event.eventId,
          revision: event.revision,
          operation: event.operation,
          eventTime: event.eventTime,
          firstRoomSeq: previous?.firstRoomSeq ?? event.roomSeq,
          roomSeq: event.roomSeq,
          replyTo: stringValue(payload.replyTo),
          mentions: stringArray(payload.mentions),
          mediaIds: stringArray(payload.mediaIds),
        });
      }
    }
    return "appended";
  }

  events(): RoomEventEnvelope[] {
    return [...this.#events.values()].sort((a, b) => a.roomSeq - b.roomSeq);
  }

  messages(): LedgerMessage[] {
    return [...this.#messages.values()].sort((a, b) => a.firstRoomSeq - b.firstRoomSeq);
  }

  reset(): void {
    this.#events.clear();
    this.#messages.clear();
    this.#lastSeq = 0;
  }

  destroy(): void {
    this.reset();
    this.#roomId = undefined;
  }
}
