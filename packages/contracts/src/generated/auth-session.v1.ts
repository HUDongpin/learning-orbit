/* generated; source is JSON Schema */

export type AuthSession =
  | {
      role: "student";
      roomId: string;
      roomMemberId: string;
      actorId: string;
      pseudonym: "探索者 A" | "探索者 B" | "探索者 C" | "探索者 D";
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
