import { realtimeContract, type RoomCommand } from "@learning-orbit/contracts";

export type RoomCommandIntent =
  | Readonly<{ type: "room.open" | "room.pause" | "room.resume" | "room.close" }>
  | Readonly<{ type: "message.add"; text: string; replyTo: string | null; mentions: readonly string[]; mediaIds: readonly string[] }>
  | Readonly<{ type: "message.revise"; messageId: string; text: string; replyTo: string | null; mentions: readonly string[]; baseRevision: number }>
  | Readonly<{ type: "message.retract"; messageId: string; baseRevision: number }>;

export interface SessionCommandTransport {
  send(command: RoomCommand): string;
}

export interface SessionCommandBus {
  send(intent: RoomCommandIntent): string;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function freezeCommand(value: Record<string, unknown>): RoomCommand {
  const payload = Object.freeze(value.payload as Record<string, unknown>);
  const command = Object.freeze({ ...value, payload }) as RoomCommand;
  // Validation happens before the command can enter the retry queue. The
  // transport receives this same immutable object and commandId on retries.
  realtimeContract.encodeRoomCommand(command);
  return command;
}

export function makeSessionCommandBus(input: Readonly<{
  roomId: string;
  clock: () => Date;
  uuid: () => string;
  transport: SessionCommandTransport;
}>): SessionCommandBus {
  return {
    send(intent) {
      const now = input.clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("COMMAND_CLOCK_INVALID");
      const commandId = input.uuid();
      const common = {
        commandId,
        roomId: input.roomId,
        clientTime: now.toISOString(),
      };
      let command: RoomCommand;
      if (intent.type === "room.open" || intent.type === "room.pause" || intent.type === "room.resume" || intent.type === "room.close") {
        command = freezeCommand({ ...common, type: intent.type, payload: {} });
      } else if (intent.type === "message.add") {
        const text = intent.text.trim();
        const mentions = unique(intent.mentions);
        const mediaIds = unique(intent.mediaIds);
        if (!text && mediaIds.length === 0) throw new Error("MESSAGE_TEXT_OR_MEDIA_REQUIRED");
        if (mediaIds.length > 4) throw new Error("MESSAGE_MEDIA_LIMIT_EXCEEDED");
        command = freezeCommand({
          ...common,
          type: intent.type,
          payload: { text, replyTo: intent.replyTo, mentions, mediaIds },
        });
      } else if (intent.type === "message.revise") {
        const text = intent.text.trim();
        if (!text) throw new Error("MESSAGE_TEXT_REQUIRED");
        command = freezeCommand({
          ...common,
          type: intent.type,
          baseRevision: intent.baseRevision,
          payload: {
            messageId: intent.messageId,
            text,
            replyTo: intent.replyTo,
            mentions: unique(intent.mentions),
          },
        });
      } else if (intent.type === "message.retract") {
        command = freezeCommand({
          ...common,
          type: intent.type,
          baseRevision: intent.baseRevision,
          payload: { messageId: intent.messageId },
        });
      } else {
        throw new Error("COMMAND_INTENT_INVALID");
      }
      const sentId = input.transport.send(command);
      if (sentId !== commandId) throw new Error("COMMAND_TRANSPORT_ID_MISMATCH");
      return commandId;
    },
  };
}
