import { describe, expect, it, vi } from "vitest";

import { makeSessionCommandBus } from "./session-command-bus.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const COMMAND_ID = "00000000-0000-4000-8000-000000000201";
const MESSAGE_ID = "00000000-0000-4000-8000-000000000501";
const ACTOR_ID = "00000000-0000-4000-8000-000000000301";
const AT = new Date("2026-08-31T01:00:00.000Z");

describe("server-bound session command bus", () => {
  it("injects immutable room, command id, and client time into a generated message command", () => {
    const send = vi.fn((command) => command.commandId as string);
    const bus = makeSessionCommandBus({
      roomId: ROOM_ID,
      clock: () => AT,
      uuid: () => COMMAND_ID,
      transport: { send },
    });

    expect(bus.send({
      type: "message.add",
      text: "  池塘的藻類增加了  ",
      replyTo: MESSAGE_ID,
      mentions: [ACTOR_ID, ACTOR_ID],
      mediaIds: [],
    })).toBe(COMMAND_ID);
    expect(send).toHaveBeenCalledWith(Object.freeze({
      commandId: COMMAND_ID,
      roomId: ROOM_ID,
      type: "message.add",
      clientTime: AT.toISOString(),
      payload: {
        text: "池塘的藻類增加了",
        replyTo: MESSAGE_ID,
        mentions: [ACTOR_ID],
        mediaIds: [],
      },
    }));
    expect(send.mock.calls[0]![0]).not.toHaveProperty("actorId");
  });

  it("builds revise and retract commands without attachment mutation", () => {
    const sent: unknown[] = [];
    const ids = [COMMAND_ID, "00000000-0000-4000-8000-000000000202"];
    const bus = makeSessionCommandBus({
      roomId: ROOM_ID,
      clock: () => AT,
      uuid: () => ids.shift()!,
      transport: { send: (command) => { sent.push(command); return command.commandId; } },
    });
    bus.send({ type: "message.revise", messageId: MESSAGE_ID, text: "修訂", replyTo: null, mentions: [], baseRevision: 2 });
    bus.send({ type: "message.retract", messageId: MESSAGE_ID, baseRevision: 3 });
    expect(sent[0]).toMatchObject({ type: "message.revise", baseRevision: 2, payload: { messageId: MESSAGE_ID, text: "修訂", replyTo: null, mentions: [] } });
    expect((sent[0] as { payload: object }).payload).not.toHaveProperty("mediaIds");
    expect(sent[1]).toMatchObject({ type: "message.retract", baseRevision: 3, payload: { messageId: MESSAGE_ID } });
  });

  it("rejects empty, over-limit, or invalid intents before transport", () => {
    const send = vi.fn();
    const bus = makeSessionCommandBus({ roomId: ROOM_ID, clock: () => AT, uuid: () => COMMAND_ID, transport: { send } });
    expect(() => bus.send({ type: "message.add", text: "   ", replyTo: null, mentions: [], mediaIds: [] })).toThrow("MESSAGE_TEXT_OR_MEDIA_REQUIRED");
    expect(() => bus.send({
      type: "message.add",
      text: "媒體過多",
      replyTo: null,
      mentions: [],
      mediaIds: Array.from({ length: 5 }, (_, index) => `00000000-0000-4000-8000-${String(700 + index).padStart(12, "0")}`),
    })).toThrow("MESSAGE_MEDIA_LIMIT_EXCEEDED");
    expect(() => bus.send({ type: "message.revise", messageId: MESSAGE_ID, text: "   ", replyTo: null, mentions: [], baseRevision: 1 })).toThrow("MESSAGE_TEXT_REQUIRED");
    expect(() => bus.send({ type: "message.retract", messageId: MESSAGE_ID, baseRevision: 0 })).toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
