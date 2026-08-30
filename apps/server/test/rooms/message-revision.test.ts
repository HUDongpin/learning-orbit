import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createCoreEventPayloadRegistry,
  type AuthSession,
  type RoomCommand,
} from "@learning-orbit/contracts";

import { runMigrations } from "../../src/db/migrate.js";
import { resetBusinessTables } from "../db/reset.js";
import { RoomEventRepository } from "../../src/modules/rooms/room-event-repository.js";
import { RoomLifecycleService } from "../../src/modules/rooms/lifecycle-service.js";
import { MessageService } from "../../src/modules/rooms/message-service.js";
import { RoomError } from "../../src/modules/rooms/errors.js";
import {
  MutableClock,
  lifecycleDatabaseUrl,
  seedLifecycleRoom,
} from "./lifecycle-test-fixture.js";

const pool = new Pool({ connectionString: lifecycleDatabaseUrl, max: 8 });
let clock: MutableClock;
let room: Awaited<ReturnType<typeof seedLifecycleRoom>>;
let lifecycle: RoomLifecycleService;
let messages: MessageService;
let actorA: { actorId: string; memberId: string };
let actorB: { actorId: string; memberId: string };

async function student(actor: { actorId: string; memberId: string }): Promise<AuthSession> {
  return {
    role: "student",
    actorId: actor.actorId,
    roomId: room.roomId,
    roomMemberId: actor.memberId,
    pseudonym: "探索者 A",
    nova: {
      actorId: room.novaActorId,
      actorKind: "agent",
      actorRole: "socratic_facilitator",
      displayName: "Nova Agent",
    },
  };
}

function command(
  type: "message.add" | "message.revise" | "message.retract",
  payload: Record<string, unknown>,
  baseRevision?: number,
  commandId = randomUUID(),
): RoomCommand {
  return {
    commandId,
    roomId: room.roomId,
    type,
    clientTime: clock.now().toISOString(),
    ...(baseRevision === undefined ? {} : { baseRevision }),
    payload,
  } as RoomCommand;
}

beforeAll(async () => runMigrations(lifecycleDatabaseUrl, "infra/postgres/migrations"));
beforeEach(async () => {
  await resetBusinessTables(lifecycleDatabaseUrl);
  clock = new MutableClock();
  room = await seedLifecycleRoom(pool);
  lifecycle = new RoomLifecycleService(
    new RoomEventRepository(pool, createCoreEventPayloadRegistry(), clock),
    clock,
  );
  await lifecycle.open(room.roomId, room.teacherId, randomUUID());
  const members = await pool.query<{ actor_id: string; room_member_id: string }>(
    "SELECT actor_id, room_member_id FROM room_member WHERE room_id=$1 ORDER BY seat_index",
    [room.roomId],
  );
  actorA = { actorId: members.rows[0]!.actor_id, memberId: members.rows[0]!.room_member_id };
  actorB = { actorId: members.rows[1]!.actor_id, memberId: members.rows[1]!.room_member_id };
  messages = new MessageService(
    new RoomEventRepository(pool, createCoreEventPayloadRegistry(), clock),
    undefined,
    clock,
  );
});

afterAll(async () => pool.end());

describe("message revisions", () => {
  it("revises by owner and optimistic revision, then retracts", async () => {
    const a = await student(actorA);
    const added = await messages.add(a, command("message.add", {
      text: "原文",
      replyTo: null,
      mentions: [],
      mediaIds: [],
    }));
    const messageId = (added.payload as { messageId: string }).messageId;
    const revised = await messages.revise(a, command("message.revise", {
      messageId,
      text: "修正",
      replyTo: null,
      mentions: [],
    }, 1));
    expect(revised).toMatchObject({ type: "message.revised", revision: 2 });
    await expect(messages.revise(a, command("message.revise", {
      messageId,
      text: "衝突",
      replyTo: null,
      mentions: [],
    }, 1))).rejects.toMatchObject({ code: "REVISION_CONFLICT", currentRevision: 2 });
    const teacher: AuthSession = { role: "teacher", teacherId: room.teacherId, actorId: room.teacherId };
    await expect(messages.revise(teacher, command("message.revise", {
      messageId,
      text: "教師改寫",
      replyTo: null,
      mentions: [],
    }, 2))).rejects.toEqual(new RoomError("FORBIDDEN"));
    const retracted = await messages.retract(a, command("message.retract", { messageId }, 2));
    expect(retracted).toMatchObject({ type: "message.retracted", revision: 3, actorId: actorA.actorId });
    await expect(messages.retract(a, command("message.retract", { messageId }, 2)))
      .rejects.toMatchObject({ code: "MESSAGE_NOT_FOUND" });
  });

  it("lets only the message owner revise and owner teacher retract", async () => {
    const a = await student(actorA);
    const b = await student(actorB);
    const added = await messages.add(a, command("message.add", {
      text: "原文", replyTo: null, mentions: [], mediaIds: [],
    }));
    const messageId = (added.payload as { messageId: string }).messageId;
    await expect(messages.revise(b, command("message.revise", {
      messageId, text: "他人改寫", replyTo: null, mentions: [],
    }, 1))).rejects.toEqual(new RoomError("FORBIDDEN"));
    const teacher: AuthSession = { role: "teacher", teacherId: room.teacherId, actorId: room.teacherId };
    const retracted = await messages.retract(teacher, command("message.retract", { messageId }, 1));
    expect(retracted.actorRole).toBe("teacher");
    await expect(messages.add(b, command("message.add", {
      text: "回覆撤回訊息", replyTo: messageId, mentions: [], mediaIds: [],
    }))).rejects.toEqual(new RoomError("INVALID_COMMAND"));
  });

  it("returns the original revision event on identical command retry", async () => {
    const a = await student(actorA);
    const added = await messages.add(a, command("message.add", {
      text: "原文", replyTo: null, mentions: [], mediaIds: [],
    }));
    const messageId = (added.payload as { messageId: string }).messageId;
    const c = command("message.revise", {
      messageId, text: "修正", replyTo: null, mentions: [],
    }, 1);
    const first = await messages.revise(a, c);
    expect(await messages.revise(a, c)).toEqual(first);
  });
});

