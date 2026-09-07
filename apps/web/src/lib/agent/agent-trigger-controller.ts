import type { RoomEventEnvelope } from "@learning-orbit/contracts";

export interface AgentTriggerPorts {
  /** The Nova actor this room's server assigned; a mention of anything else is not a trigger. */
  readonly novaActorId: string;
  /** The student whose client this is. Nobody may trigger on another seat's message. */
  readonly actorId: string;
  readonly requestRun: (triggerEventId: string) => Promise<unknown>;
}

/**
 * Ask Nova to answer, once, for one committed message.
 *
 * Three properties this exists to hold. A run is triggered only by an event
 * the server has already committed, never by text the composer is optimistically
 * showing - otherwise Nova answers a message that may never have existed. Only
 * the author's own client triggers, so four students reading the same message
 * do not produce four runs. And every event is triggered at most once locally,
 * so a replay after reconnect does not re-ask; the server is idempotent too,
 * but a client that floods it is still wrong.
 */
export class AgentTriggerController {
  readonly #requested = new Set<string>();

  constructor(private readonly ports: AgentTriggerPorts) {}

  /** True when this committed event mentions Nova and belongs to this seat. */
  shouldTrigger(event: RoomEventEnvelope): boolean {
    if (event.type !== "message.added" || event.operation !== "add") return false;
    if (event.actorKind !== "human" || event.actorRole !== "student") return false;
    if (event.actorId !== this.ports.actorId) return false;
    const payload = event.payload as { mentions?: unknown };
    const mentions = Array.isArray(payload.mentions) ? payload.mentions : [];
    return mentions.includes(this.ports.novaActorId);
  }

  /**
   * Observe one committed event. Returns whether a run was requested, so a
   * caller can surface the attempt without inspecting internal state.
   */
  async observe(event: RoomEventEnvelope): Promise<boolean> {
    if (!this.shouldTrigger(event)) return false;
    if (this.#requested.has(event.eventId)) return false;
    this.#requested.add(event.eventId);
    try {
      await this.ports.requestRun(event.eventId);
      return true;
    } catch {
      // The event stays marked. A failed request is the server's to retry
      // through its own state, not something to re-ask on the next replay.
      return false;
    }
  }

  /** Events this client has already asked about, for a reconnect to skip. */
  requestedEventIds(): readonly string[] {
    return [...this.#requested];
  }
}
