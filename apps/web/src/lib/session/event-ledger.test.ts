import { describe, expect, it } from "vitest";

import { EventLedger } from "./event-ledger.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const MESSAGE_ONE = "00000000-0000-4000-8000-000000000501";
const MESSAGE_TWO = "00000000-0000-4000-8000-000000000502";

function event(
  seq: number,
  operation: "add" | "revise" | "retract" = "add",
  messageId = MESSAGE_ONE,
  eventTime = `2026-08-30T09:0${Math.min(seq, 9)}:00.000Z`,
) {
  const type = operation === "add" ? "message.added" : operation === "revise" ? "message.revised" : "message.retracted";
  return {
    eventId: `00000000-0000-4000-8001-${String(seq).padStart(12, "0")}`,
    schemaVersion: 1 as const,
    roomId: ROOM_ID,
    roomSeq: seq,
    type,
    actorId: "00000000-0000-4000-8000-000000000301",
    actorKind: "human" as const,
    actorRole: "student" as const,
    revision: operation === "add" ? 1 : 2,
    operation,
    eventTime,
    ingestTime: `2026-08-30T09:1${Math.min(seq, 9)}:00.000Z`,
    causationId: `00000000-0000-4000-8002-${String(seq).padStart(12, "0")}`,
    correlationId: "00000000-0000-4000-8000-000000000401",
    payload: operation === "retract"
      ? { messageId }
      : {
          messageId,
          text: operation === "revise" ? "修訂後" : messageId === MESSAGE_TWO ? "第二則" : "原始",
          replyTo: null,
          mentions: [],
          mediaIds: [],
        },
  };
}

describe("server-sequenced event ledger", () => {
  it("parses first, accepts only contiguous roomSeq, and classifies duplicate/stale/gap", () => {
    const ledger = new EventLedger(ROOM_ID);
    expect(ledger.append(event(1))).toBe("appended");
    expect(ledger.append(event(1))).toBe("duplicate");
    expect(ledger.append(event(3, "add", MESSAGE_TWO))).toBe("gap");
    expect(ledger.lastRoomSeq).toBe(1);
    expect(ledger.append({ ...event(1), eventId: "00000000-0000-4000-8001-000000000099" })).toBe("stale");
    expect(ledger.append(event(2, "revise"))).toBe("appended");
    expect(ledger.append(event(3, "add", MESSAGE_TWO))).toBe("appended");
    expect(ledger.events().map(({ roomSeq }) => roomSeq)).toEqual([1, 2, 3]);
  });

  it("orders messages by first server sequence rather than eventTime and preserves the latest revision", () => {
    const ledger = new EventLedger(ROOM_ID);
    ledger.append(event(1, "add", MESSAGE_ONE, "2026-08-30T09:30:00.000Z"));
    ledger.append(event(2, "revise", MESSAGE_ONE, "2026-08-30T09:00:00.000Z"));
    ledger.append(event(3, "add", MESSAGE_TWO, "2026-08-30T08:00:00.000Z"));
    expect(ledger.messages().map(({ messageId }) => messageId)).toEqual([MESSAGE_ONE, MESSAGE_TWO]);
    expect(ledger.messages()[0]).toMatchObject({ text: "修訂後", revision: 2, firstRoomSeq: 1, roomSeq: 2 });
  });

  it("rejects malformed payloads and cross-room events before mutating state", () => {
    const ledger = new EventLedger(ROOM_ID);
    expect(() => ledger.append({ ...event(1), payload: { messageId: MESSAGE_ONE, text: 42 } }))
      .toThrow();
    expect(() => ledger.append({ ...event(1), roomId: "00000000-0000-4000-8000-000000000099" }))
      .toThrow("ROOM_EVENT_ROOM_MISMATCH");
    expect(ledger.lastRoomSeq).toBe(0);

    const extensionLedger = new EventLedger(ROOM_ID);
    expect(extensionLedger.append({ ...event(1), type: "analytics.extension", payload: { messageId: MESSAGE_ONE, text: "不得進入聊天" } }))
      .toBe("appended");
    expect(extensionLedger.events()).toHaveLength(1);
    expect(extensionLedger.messages()).toEqual([]);
  });

  it("clears every durable event, message, and cursor on reset", () => {
    const ledger = new EventLedger(ROOM_ID);
    ledger.append(event(1));
    ledger.reset();
    expect(ledger.lastRoomSeq).toBe(0);
    expect(ledger.events()).toEqual([]);
    expect(ledger.messages()).toEqual([]);
  });
});
