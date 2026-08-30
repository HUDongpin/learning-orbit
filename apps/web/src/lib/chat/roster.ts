import type { RoomDetails } from "@learning-orbit/contracts";

export type RosterMember = Readonly<{
  actorId: string;
  pseudonym: string;
  actorKind: "human" | "agent";
  actorRole: "student" | "socratic_facilitator";
}>;

/** Local view selector only; it never becomes a wire `members` field. */
export function roomRoster(room: RoomDetails): RosterMember[] {
  return [
    ...room.participants.map((participant) => ({ ...participant })),
    {
      actorId: room.nova.actorId,
      pseudonym: room.nova.displayName,
      actorKind: room.nova.actorKind,
      actorRole: room.nova.actorRole,
    },
  ];
}
