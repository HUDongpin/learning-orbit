import type { Pool, PoolClient } from "pg";
import type { AuthSession } from "@learning-orbit/contracts";

export const ROOM_ACTIONS = Object.freeze([
  "room_read",
  "room_command",
  "analytics_read",
  "media_read",
  "media_write",
  "agent_trigger",
  "export_request",
  "deletion_request",
] as const);

export type RoomAction = (typeof ROOM_ACTIONS)[number];

/** What each role may do. A role is never granted an action by omission. */
const ROLE_ACTIONS: Readonly<Record<"teacher" | "student", ReadonlySet<RoomAction>>> = Object.freeze({
  teacher: new Set<RoomAction>([
    "room_read", "room_command", "analytics_read", "media_read",
    "export_request", "deletion_request",
  ]),
  student: new Set<RoomAction>([
    "room_read", "room_command", "analytics_read", "media_read",
    "media_write", "agent_trigger",
  ]),
});

export class RoomAuthorizationError extends Error {
  constructor(readonly statusCode: 401 | 404 | 410, readonly code: string) {
    super(code);
  }
}

export interface RoomActorGrant {
  readonly roomId: string;
  readonly actorId: string;
  readonly actorKind: "human";
  readonly role: "teacher" | "student";
  readonly action: RoomAction;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The one place a room action is authorized.
 *
 * Fourteen call sites each re-derived "is this principal allowed to touch this
 * room", and every one of them had to remember the same four things in the
 * same order: the session is still current, the room is not being deleted, the
 * principal really belongs to *this* room, and the role may perform *this*
 * action. A rule repeated fourteen times is a rule that will eventually be
 * enforced thirteen times.
 *
 * Two decisions are deliberate. Everything that is not an authentication
 * problem answers 404, so a room that exists but belongs to someone else is
 * indistinguishable from one that does not - otherwise the error itself
 * enumerates rooms. And deletion answers 410 before ownership is even checked,
 * because a room being deleted must not be readable by anyone, including its
 * owner.
 */
export async function authorizeRoomAction(
  client: Pool | PoolClient,
  principal: AuthSession | null,
  sessionId: string | undefined,
  roomId: string,
  action: RoomAction,
): Promise<RoomActorGrant> {
  if (!principal) throw new RoomAuthorizationError(401, "AUTH_REQUIRED");
  if (!sessionId || !UUID.test(sessionId)) throw new RoomAuthorizationError(401, "AUTH_REQUIRED");
  if (!UUID.test(roomId)) throw new RoomAuthorizationError(404, "ROOM_NOT_FOUND");
  if (!ROOM_ACTIONS.includes(action)) throw new RoomAuthorizationError(404, "ROOM_NOT_FOUND");

  // Checked before ownership: a room being deleted is unreadable by everyone.
  const deleting = await client.query<{ deleting: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM deletion_job
       WHERE room_id = $1 AND status IN ('queued','running','retryable','dead')
     ) AS deleting`,
    [roomId],
  );
  if (deleting.rows[0]?.deleting === true) {
    throw new RoomAuthorizationError(410, "ROOM_DELETION_IN_PROGRESS");
  }

  if (principal.role === "teacher") {
    if (!ROLE_ACTIONS.teacher.has(action)) throw new RoomAuthorizationError(404, "ROOM_NOT_FOUND");
    const owned = await client.query<{ teacher_id: string }>(
      `SELECT r.teacher_id FROM classroom_room r
       WHERE r.room_id = $1 AND r.teacher_id = $2
         AND EXISTS (
           SELECT 1 FROM auth_session s
           WHERE s.session_id = $3::uuid AND s.teacher_id = r.teacher_id
             AND s.principal_kind = 'teacher' AND s.revoked_at IS NULL
             AND s.expires_at > transaction_timestamp())`,
      [roomId, principal.teacherId, sessionId],
    );
    if (!owned.rows[0]) throw new RoomAuthorizationError(404, "ROOM_NOT_FOUND");
    return Object.freeze({
      roomId, actorId: principal.teacherId, actorKind: "human", role: "teacher", action,
    });
  }

  if (!ROLE_ACTIONS.student.has(action)) throw new RoomAuthorizationError(404, "ROOM_NOT_FOUND");
  const member = await client.query<{ actor_id: string }>(
    `SELECT m.actor_id FROM room_member m
     WHERE m.room_id = $1 AND m.room_member_id = $2 AND m.actor_id = $3
       AND EXISTS (
         SELECT 1 FROM auth_session s
         WHERE s.session_id = $4::uuid AND s.room_member_id = m.room_member_id
           AND s.principal_kind = 'student' AND s.revoked_at IS NULL
           AND s.expires_at > transaction_timestamp())`,
    [roomId, principal.roomMemberId, principal.actorId, sessionId],
  );
  const actorId = member.rows[0]?.actor_id;
  if (!actorId) throw new RoomAuthorizationError(404, "ROOM_NOT_FOUND");
  return Object.freeze({ roomId, actorId, actorKind: "human", role: "student", action });
}

/**
 * Deletion status is readable only by the teacher who owns the job, and only
 * through the job itself - never by asking whether a room exists.
 */
export async function authorizeDeletionStatusRead(
  client: Pool | PoolClient,
  principal: AuthSession | null,
  sessionId: string | undefined,
  deletionJobId: string,
): Promise<{ deletionJobId: string; ownerTeacherId: string }> {
  if (!principal) throw new RoomAuthorizationError(401, "AUTH_REQUIRED");
  if (principal.role !== "teacher") throw new RoomAuthorizationError(404, "DELETION_JOB_NOT_FOUND");
  if (!sessionId || !UUID.test(sessionId) || !UUID.test(deletionJobId)) {
    throw new RoomAuthorizationError(404, "DELETION_JOB_NOT_FOUND");
  }
  const job = await client.query<{ owner_teacher_id: string }>(
    `SELECT d.owner_teacher_id FROM deletion_job d
     WHERE d.deletion_job_id = $1 AND d.owner_teacher_id = $2
       AND EXISTS (
         SELECT 1 FROM auth_session s
         WHERE s.session_id = $3::uuid AND s.teacher_id = d.owner_teacher_id
           AND s.principal_kind = 'teacher' AND s.revoked_at IS NULL
           AND s.expires_at > transaction_timestamp())`,
    [deletionJobId, principal.teacherId, sessionId],
  );
  const ownerTeacherId = job.rows[0]?.owner_teacher_id;
  if (!ownerTeacherId) throw new RoomAuthorizationError(404, "DELETION_JOB_NOT_FOUND");
  return Object.freeze({ deletionJobId, ownerTeacherId });
}
