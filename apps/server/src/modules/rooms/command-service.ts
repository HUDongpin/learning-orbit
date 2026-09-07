import { realtimeContract, type AuthSession, type RoomCommand } from "@learning-orbit/contracts";
import { MessageService } from "./message-service.js";
import type { RoomLifecycleService } from "./lifecycle-service.js";
import { RoomError } from "./errors.js";
import { createTelemetry, type Telemetry } from "../../observability/telemetry.js";

export class CommandService {
  constructor(
    private readonly messages: MessageService,
    private readonly lifecycle: RoomLifecycleService,
    private readonly telemetry: Telemetry = createTelemetry(),
  ) {}

  async dispatch(principal: AuthSession, value: unknown, sessionId?: string) {
    let c: RoomCommand;
    try {
      const frame = realtimeContract.parseRealtimeFrame({ type: "command", command: value });
      c = (frame as { command: RoomCommand }).command;
    } catch {
      throw new RoomError("INVALID_COMMAND");
    }
    if (c.roomId !== (value as { roomId?: string } | null)?.roomId) {
      throw new RoomError("INVALID_COMMAND");
    }
    // The span is opened around the whole accept-to-commit path and closed
    // with the committed event's own identifiers, so the trace is joined by
    // the correlation id the ledger actually persisted.  A rejected command
    // still closes its span, carrying the safe failure code and nothing else.
    const span = this.telemetry.startSpan("command.accept", {
      roomId: c.roomId, commandId: c.commandId, commandType: c.type,
    });
    try {
      const event = await this.#route(principal, c, sessionId);
      const committed = {
        eventId: event.eventId, roomSeq: event.roomSeq,
        correlationId: event.correlationId, causationId: event.causationId,
      };
      span.end(undefined, committed);
      this.telemetry.record("room_event.commit", { roomId: event.roomId, ...committed });
      return event;
    } catch (error) {
      span.end(undefined, { failureCode: error instanceof RoomError ? error.code : "UNKNOWN_ERROR" });
      throw error;
    }
  }

  async #route(principal: AuthSession, c: RoomCommand, sessionId?: string) {
    if (c.type === "message.add") return this.messages.add(principal, c, sessionId);
    if (c.type === "message.revise") return this.messages.revise(principal, c, sessionId);
    if (c.type === "message.retract") return this.messages.retract(principal, c, sessionId);
    if (principal.role !== "teacher") throw new RoomError("FORBIDDEN");
    if (c.type === "room.open") return this.lifecycle.open(c.roomId, principal.teacherId, c.commandId, sessionId);
    if (c.type === "room.pause") return this.lifecycle.pause(c.roomId, principal.teacherId, c.commandId, sessionId);
    if (c.type === "room.resume") return this.lifecycle.resume(c.roomId, principal.teacherId, c.commandId, sessionId);
    return this.lifecycle.close(c.roomId, principal.teacherId, c.commandId, sessionId);
  }
}
