/* generated; source is JSON Schema */

export type AuthSession =
  | {
      role: "student";
      roomId: string;
      roomMemberId: string;
      actorId: string;
      pseudonym: string;
      nova: {
        actorId: string;
        actorKind: "agent";
        actorRole: "socratic_facilitator";
        displayName: "Nova Agent";
      };
    }
  | {
      role: "teacher";
      teacherId: string;
      actorId: string;
    };
