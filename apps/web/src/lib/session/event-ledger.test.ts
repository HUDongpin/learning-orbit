import { describe, expect, it } from "vitest";
import { EventLedger } from "./event-ledger.js";

const event = (seq: number, operation: "add" | "revise" | "retract" = "add") => ({
  eventId: `event-${seq}-${operation}`, schemaVersion: 1 as const, roomId: "room-1", roomSeq: seq, type: "message.added", actorId: "student-a", actorKind: "human" as const, actorRole: "student" as const,
  revision: operation === "add" ? 1 : 2, operation, eventTime: `2026-08-30T09:0${seq}:00.000Z`, ingestTime: `2026-08-30T09:0${seq}:00.000Z`, causationId: "command-1", correlationId: "correlation-1",
  payload: { messageId: "message-1", text: operation === "retract" ? "" : operation === "revise" ? "修訂後" : "原始", replyTo: null, mentions: [], mediaIds: [] },
});

describe("event ledger", () => {
  it("deduplicates event ids and preserves latest message revision", () => {
    const ledger = new EventLedger();
    const first = event(1);
    expect(ledger.append(first)).toBe(true);
    expect(ledger.append(first)).toBe(false);
    expect(ledger.append(event(2, "revise"))).toBe(true);
    expect(ledger.messages()[0]).toMatchObject({ text: "修訂後", revision: 2, operation: "revise" });
    expect(ledger.append(event(3, "retract"))).toBe(true);
    expect(ledger.messages()[0]?.operation).toBe("retract");
  });
});
