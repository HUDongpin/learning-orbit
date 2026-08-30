import type { RoomEventEnvelope } from "../contracts.js";

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

  get lastRoomSeq(): number {
    return this.#lastSeq;
  }

  append(event: RoomEventEnvelope): boolean {
    if (this.#events.has(event.eventId) || event.roomSeq <= this.#lastSeq) return false;
    this.#events.set(event.eventId, event);
    this.#lastSeq = Math.max(this.#lastSeq, event.roomSeq);
    const payload = event.payload;
    const messageId = stringValue(payload.messageId);
    if (messageId) {
      const previous = this.#messages.get(messageId);
      if (!previous || event.revision >= previous.revision) {
        this.#messages.set(messageId, {
          messageId,
          text: stringValue(payload.text) ?? "",
          actorId: event.actorId,
          actorKind: event.actorKind,
          actorRole: event.actorRole,
          eventId: event.eventId,
          revision: event.revision,
          operation: event.operation,
          eventTime: event.eventTime,
          replyTo: stringValue(payload.replyTo),
          mentions: stringArray(payload.mentions),
          mediaIds: stringArray(payload.mediaIds),
        });
      }
    }
    return true;
  }

  events(): RoomEventEnvelope[] {
    return [...this.#events.values()].sort((a, b) => a.roomSeq - b.roomSeq);
  }

  messages(): LedgerMessage[] {
    return [...this.#messages.values()].sort((a, b) => a.eventTime.localeCompare(b.eventTime));
  }

  reset(): void {
    this.#events.clear();
    this.#messages.clear();
    this.#lastSeq = 0;
  }
}
