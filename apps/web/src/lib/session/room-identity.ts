import type { AuthSession, RoomDetails } from "@learning-orbit/contracts";

const STUDENT_PSEUDONYMS = new Set(["探索者 A", "探索者 B", "探索者 C", "探索者 D"]);

export function assertRoomRosterIntegrity(room: RoomDetails): void {
  const participantActorIds = room.participants.map(({ actorId }) => actorId);
  const participantPseudonyms = room.participants.map(({ pseudonym }) => pseudonym);
  if (room.participants.length !== STUDENT_PSEUDONYMS.size
    || new Set(participantActorIds).size !== room.participants.length
    || participantActorIds.includes(room.nova.actorId)
    || new Set(participantPseudonyms).size !== STUDENT_PSEUDONYMS.size
    || participantPseudonyms.some((pseudonym) => !STUDENT_PSEUDONYMS.has(pseudonym))
    || room.participants.some(({ actorKind, actorRole }) => actorKind !== "human" || actorRole !== "student")
    || room.nova.actorKind !== "agent"
    || room.nova.actorRole !== "socratic_facilitator"
    || room.nova.displayName !== "Nova Agent") {
    throw new Error("ROOM_ROSTER_IDENTITY_MISMATCH");
  }
}

export function assertStudentRoomIdentity(
  session: Extract<AuthSession, { role: "student" }>,
  room: RoomDetails,
): void {
  assertRoomRosterIntegrity(room);
  const self = room.participants.find(({ actorId }) => actorId === session.actorId);
  if (room.roomId !== session.roomId
    || self?.pseudonym !== session.pseudonym
    || self.actorKind !== "human"
    || self.actorRole !== "student"
    || session.nova.actorId !== room.nova.actorId
    || session.nova.actorKind !== room.nova.actorKind
    || session.nova.actorRole !== room.nova.actorRole
    || session.nova.displayName !== room.nova.displayName) {
    throw new Error("STUDENT_ROOM_IDENTITY_MISMATCH");
  }
}
