import { describe, expect, it } from "vitest";

import { roomHttpContract } from "../src/index.js";

const roomId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const memberIds = [
  "33333333-3333-4333-8333-333333333331",
  "33333333-3333-4333-8333-333333333332",
  "33333333-3333-4333-8333-333333333333",
  "33333333-3333-4333-8333-333333333334",
] as const;
const studentPseudonyms = ["探索者 A", "探索者 B", "探索者 C", "探索者 D"] as const;

const nova = {
  actorId,
  actorKind: "agent" as const,
  actorRole: "socratic_facilitator" as const,
  displayName: "Nova Agent" as const,
};

describe("room HTTP runtime contract", () => {
  it("parses normalized create input and strict uppercase join codes", () => {
    expect(roomHttpContract.parseCreateRoomRequest({ topic: "  生態系統  " }))
      .toEqual({ topic: "生態系統" });
    expect(() => roomHttpContract.parseCreateRoomRequest({ topic: "   " }))
      .toThrow("INVALID_CREATE_ROOM_REQUEST");
    expect(() => roomHttpContract.parseCreateRoomRequest({ topic: "生態", extra: true }))
      .toThrow("INVALID_CREATE_ROOM_REQUEST");
    expect(roomHttpContract.parseJoinRoomRequest({ roomCode: "ABC234", seatCode: "DEF567GHJK" }))
      .toEqual({ roomCode: "ABC234", seatCode: "DEF567GHJK" });
    expect(() => roomHttpContract.parseJoinRoomRequest({ roomCode: "ABC23I", seatCode: "DEF567GHJK" }))
      .toThrow("INVALID_JOIN_ROOM_REQUEST");
    expect(() => roomHttpContract.parseJoinRoomRequest({ roomCode: "abc234", seatCode: "DEF567GHJK" }))
      .toThrow("INVALID_JOIN_ROOM_REQUEST");
  });

  it("encodes only closed create, join, and details response shapes", () => {
    const seatInvites = memberIds.map((roomMemberId, index) => ({
      roomMemberId,
      actorId: `44444444-4444-4444-8444-44444444444${index}`,
      pseudonym: studentPseudonyms[index]!,
      code: ["ABC234DEFG", "BCD345EFGH", "CDE456FGHJ", "DEF567GHJK"][index]!,
    }));
    const create = {
      room: { roomId, roomCode: "ABC234", status: "scheduled" as const, durationSeconds: 2700 as const, nova },
      seatInvites,
    };
    const join = { roomMemberId: memberIds[0], actorId, pseudonym: "探索者 A" };
    const details = {
      roomId, topic: "生態系統", status: "scheduled" as const, durationSeconds: 2700 as const,
      startsAt: null, closesAt: null, nova,
      participants: seatInvites.map(({ actorId: participantActorId, pseudonym }) => ({
        actorId: participantActorId, pseudonym, actorKind: "human" as const, actorRole: "student" as const,
      })),
    };

    expect(JSON.parse(roomHttpContract.encodeCreateRoomResponse(create))).toEqual(create);
    expect(JSON.parse(roomHttpContract.encodeJoinRoomResponse(join))).toEqual(join);
    expect(JSON.parse(roomHttpContract.encodeRoomDetails(details))).toEqual(details);
    expect(() => roomHttpContract.encodeJoinRoomResponse({ ...join, roomId }))
      .toThrow("INVALID_JOIN_ROOM_RESPONSE");
    expect(() => roomHttpContract.encodeRoomDetails({ ...details, seatCodes: ["SECRET"] }))
      .toThrow("INVALID_ROOM_DETAILS");
    expect(() => roomHttpContract.encodeJoinRoomResponse({ ...join, pseudonym: "王同學" }))
      .toThrow("INVALID_JOIN_ROOM_RESPONSE");
    expect(() => roomHttpContract.encodeRoomDetails({
      ...details,
      participants: details.participants.map((participant, index) => (
        index === 3 ? { ...participant, pseudonym: "王同學" } : participant
      )),
    })).toThrow("INVALID_ROOM_DETAILS");
  });
});
