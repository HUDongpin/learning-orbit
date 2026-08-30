import { realtimeContract, type AuthSession, type RoomCommand } from "@learning-orbit/contracts";
import { MessageService } from "./message-service.js";
import type { RoomLifecycleService } from "./lifecycle-service.js";
import { RoomError } from "./errors.js";

export class CommandService {
  constructor(
    private readonly messages: MessageService,
    private readonly lifecycle: RoomLifecycleService,
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
