import { parseCoreRoomEvent, realtimeContract, type RoomEventEnvelope } from "../contracts";

export type LedgerAppendResult = "appended" | "duplicate" | "stale" | "gap";

export type LedgerMessage = {
  messageId: string;
  text: string;
  actorId: string;
  actorKind: RoomEventEnvelope["actorKind"];
  actorRole: RoomEventEnvelope["actorRole"];
  eventId: string;
  causationId: string;
  revision: number;
  operation: RoomEventEnvelope["operation"];
  eventTime: string;
  firstRoomSeq: number;
  roomSeq: number;
  replyTo: string | null;
  mentions: string[];
  mediaIds: string[];
};

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
    const core = parseCoreRoomEvent(event);
    let nextMessage: LedgerMessage | undefined;
    if (core && (core.type === "message.added" || core.type === "message.revised" || core.type === "message.retracted")) {
      const messageId = core.payload.messageId;
      const previous = this.#messages.get(messageId);
      if (!previous || event.revision >= previous.revision) {
        const visible = core.type === "message.retracted" ? undefined : core.payload;
        nextMessage = {
          messageId,
          text: visible?.text ?? previous?.text ?? "",
          actorId: previous?.actorId ?? event.actorId,
          actorKind: previous?.actorKind ?? event.actorKind,
          actorRole: previous?.actorRole ?? event.actorRole,
          eventId: event.eventId,
          causationId: event.causationId,
          revision: event.revision,
          operation: event.operation,
          eventTime: event.eventTime,
          firstRoomSeq: previous?.firstRoomSeq ?? event.roomSeq,
          roomSeq: event.roomSeq,
          replyTo: visible?.replyTo ?? previous?.replyTo ?? null,
          mentions: visible ? [...visible.mentions] : previous?.mentions ?? [],
          mediaIds: visible ? [...visible.mediaIds] : previous?.mediaIds ?? [],
        };
      }
    }
    this.#events.set(event.eventId, event);
    this.#lastSeq = event.roomSeq;
    if (nextMessage) this.#messages.set(nextMessage.messageId, nextMessage);
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
