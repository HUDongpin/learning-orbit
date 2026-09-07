import { describe, expect, it } from "vitest";

import { CommandService } from "../../src/modules/rooms/command-service.js";
import { RoomError } from "../../src/modules/rooms/errors.js";
import { InMemoryTelemetry, createTelemetry } from "../../src/observability/telemetry.js";
import type { MessageService } from "../../src/modules/rooms/message-service.js";
import type { RoomLifecycleService } from "../../src/modules/rooms/lifecycle-service.js";
import type { AuthSession } from "@learning-orbit/contracts";

const ROOM = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const COMMAND = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
const CORRELATION = "3f2504e0-4f89-41d3-9a0c-0305e82c3303";

const student: AuthSession = {
  role: "student", roomId: ROOM, actorId: "3f2504e0-4f89-41d3-9a0c-0305e82c3304",
} as unknown as AuthSession;

function command(text: string) {
  return {
    type: "message.add", roomId: ROOM, commandId: COMMAND,
    clientTime: "2026-01-01T00:00:00.000Z",
    payload: { text, replyTo: null, mentions: [], mediaIds: [] },
  };
}

function service(messages: Partial<MessageService>, sink: InMemoryTelemetry) {
  return new CommandService(
    messages as MessageService,
    {} as RoomLifecycleService,
    createTelemetry({ sink, now: () => 1_000 }),
  );
}

describe("pipeline spans", () => {
  it("names the committed correlation id and never the message body", async () => {
    const sink = new InMemoryTelemetry();
    const commands = service({
      add: async () => ({
        eventId: "3f2504e0-4f89-41d3-9a0c-0305e82c3305", roomId: ROOM, roomSeq: 12,
        correlationId: CORRELATION, causationId: COMMAND,
      }),
    } as unknown as Partial<MessageService>, sink);

    await commands.dispatch(student, command("a message nobody outside the room may read"));

    expect(sink.spans.map((span) => span.name)).toEqual(["command.accept", "room_event.commit"]);
    for (const span of sink.spans) {
      expect(span.attributes.correlationId).toBe(CORRELATION);
      expect(span.attributes.roomSeq).toBe(12);
    }
    expect(JSON.stringify(sink.spans)).not.toContain("nobody outside the room");
  });

  it("closes the span of a rejected command with a safe code", async () => {
    const sink = new InMemoryTelemetry();
    const commands = service({
      add: async () => { throw new RoomError("FORBIDDEN"); },
    } as unknown as Partial<MessageService>, sink);

    await expect(commands.dispatch(student, command("hello"))).rejects.toThrow(RoomError);
    expect(sink.spans).toHaveLength(1);
    expect(sink.spans[0]?.name).toBe("command.accept");
    expect(sink.spans[0]?.attributes.failureCode).toBe("FORBIDDEN");
    // A rejected command has no committed event, so it must not claim one.
    expect(sink.spans[0]?.attributes.correlationId).toBeUndefined();
  });

  it("records nothing for a frame that never became a command", async () => {
    const sink = new InMemoryTelemetry();
    const commands = service({} as Partial<MessageService>, sink);
    await expect(commands.dispatch(student, { type: "nonsense" })).rejects.toThrow(RoomError);
    expect(sink.spans).toEqual([]);
  });
});
