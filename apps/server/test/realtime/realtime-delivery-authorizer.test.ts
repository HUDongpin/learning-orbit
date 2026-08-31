import { describe, expect, it, vi } from "vitest";

import { RealtimeDeliveryAuthorizer } from "../../src/modules/realtime/realtime-delivery-authorizer.js";

const ROOM_ID = "00000000-0000-4000-8000-000000000010";
const SESSION_ID = "00000000-0000-4000-8000-000000000011";
const TEACHER_ID = "00000000-0000-4000-8000-000000000012";

function teacherRow(deletionActive: boolean, roomStatus: "open" | "closed" = "open") {
  return {
    session_id: SESSION_ID,
    principal_kind: "teacher" as const,
    teacher_id: TEACHER_ID,
    room_id: null,
    room_member_id: null,
    actor_id: null,
    pseudonym: null,
    nova_actor_id: "00000000-0000-4000-8000-000000000013",
    room_status: roomStatus,
    deletion_active: deletionActive,
  };
}

describe("realtime delivery room tombstone", () => {
  it("keeps closed-room reads authorized but rejects a new socket after normal close", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [teacherRow(false)] })
      .mockResolvedValueOnce({ rows: [teacherRow(false, "closed")] })
      .mockResolvedValueOnce({ rows: [teacherRow(false, "closed")] });
    const authorizer = new RealtimeDeliveryAuthorizer({ query } as never);
    await expect(authorizer.authenticateToken("opaque-session", ROOM_ID)).resolves.toMatchObject({
      ok: true,
      sessionId: SESSION_ID,
      actorId: TEACHER_ID,
      principal: { role: "teacher", teacherId: TEACHER_ID },
    });
    await expect(authorizer.authenticateToken("opaque-session", ROOM_ID)).resolves.toMatchObject({
      ok: true,
      sessionId: SESSION_ID,
      actorId: TEACHER_ID,
    });
    await expect(authorizer.authenticateWebSocketToken("opaque-session", ROOM_ID))
      .resolves.toEqual({ ok: false, closeCode: 4410 });
    expect(query.mock.calls[0]?.[0]).toContain("deletion_active");
  });

  it("returns 4410 only for an active deletion tombstone", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [teacherRow(true)] })
      .mockResolvedValueOnce({ rows: [teacherRow(true)] });
    const authorizer = new RealtimeDeliveryAuthorizer({ query } as never);
    await expect(authorizer.authenticateToken("opaque-session", ROOM_ID)).resolves.toEqual({ ok: false, closeCode: 4410 });
    await expect(authorizer.authenticateWebSocketToken("opaque-session", ROOM_ID)).resolves.toEqual({ ok: false, closeCode: 4410 });
  });

  it("applies the same closed-versus-deleting distinction during reauthorization", async () => {
    const closedQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ token_hash: Buffer.alloc(32) }] })
      .mockResolvedValueOnce({ rows: [teacherRow(false, "closed")] });
    const closed = new RealtimeDeliveryAuthorizer({ query: closedQuery } as never);
    await expect(closed.reauthorize(SESSION_ID, ROOM_ID)).resolves.toMatchObject({ ok: true, actorId: TEACHER_ID });

    const deletingQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ token_hash: Buffer.alloc(32) }] })
      .mockResolvedValueOnce({ rows: [teacherRow(true)] });
    const deleting = new RealtimeDeliveryAuthorizer({ query: deletingQuery } as never);
    await expect(deleting.reauthorize(SESSION_ID, ROOM_ID)).resolves.toEqual({ ok: false, closeCode: 4410 });
  });
});
