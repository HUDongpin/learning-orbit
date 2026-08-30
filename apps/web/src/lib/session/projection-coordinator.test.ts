import { describe, expect, it } from "vitest";
import type { RoomEventEnvelope } from "../contracts.js";
import { EventLedger } from "./event-ledger.js";
import { coordinateProjections } from "./projection-coordinator.js";

const base = (seq: number, text: string, actorId = "student-a"): RoomEventEnvelope => {
  const common = {
    eventId: `00000000-0000-4000-8000-000000000${String(seq).padStart(3, "0")}`,
    schemaVersion: 1 as const, roomId: "00000000-0000-4000-8000-000000000010", roomSeq: seq,
    type: "message.added", actorId, revision: 1, operation: "add" as const,
    eventTime: `2026-08-30T09:0${seq}:00.000Z`, ingestTime: `2026-08-30T09:0${seq}:00.000Z`,
    causationId: "00000000-0000-4000-8000-000000000401", correlationId: "00000000-0000-4000-8000-000000000402",
    payload: { messageId: `m${seq}`, text, replyTo: null, mentions: [], mediaIds: [] },
  };
  return actorId === "nova" ? { ...common, actorKind: "agent", actorRole: "socratic_facilitator" } : { ...common, actorKind: "human", actorRole: "student" };
};

describe("session projections", () => {
  it("is idempotent and produces evidence-backed concept/social projections", () => {
    const ledger = new EventLedger();
    const one = base(1, "太陽提供能量給生產者");
    const two = base(2, "我不確定能量會不會循環", "student-d");
    ledger.append(one); ledger.append(one); ledger.append(two);
    const projection = coordinateProjections(ledger.messages());
    expect(ledger.events()).toHaveLength(2);
    expect(projection.edges.find((edge) => edge.id === "e1")?.evidenceIds).toEqual([one.eventId]);
    expect(projection.edges.find((edge) => edge.id === "e3")?.state).toBe("mixed");
    expect(projection.socialEdges.every((edge) => edge.evidenceIds.length > 0)).toBe(true);
  });
});
