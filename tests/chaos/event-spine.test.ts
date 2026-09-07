/**
 * The event spine under process loss.
 *
 * The promise a classroom depends on is narrow and absolute: a message the
 * server acknowledged is in the ledger, exactly once, and reaches every
 * connected client exactly once, whatever happens to the process afterwards.
 * These scenarios take that promise apart one fault at a time.
 *
 * They read the ledger and the outbox directly rather than an API, because the
 * question is what survived, and an API answer could be served from something
 * that did not.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabasePool } from "../../apps/server/src/db/pool.js";
import { resetBusinessTables } from "../../apps/server/test/db/reset.js";
import { seedLifecycleRoom } from "../../apps/server/test/rooms/lifecycle-test-fixture.js";
import { RoomEventRepository } from "../../apps/server/src/modules/rooms/room-event-repository.js";
import { OutboxPublisher } from "../../apps/server/src/modules/realtime/outbox-publisher.js";
import { createCoreEventPayloadRegistry } from "@learning-orbit/contracts";
import { systemClock } from "../../apps/server/src/clock.js";
import {
  chaosVerdict,
  committedEvents,
  publishedOutbox,
  unpublishedOutbox,
} from "./support/faults.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for chaos tests");

let pool: ReturnType<typeof createDatabasePool>;
let roomId: string;
let actorId: string;

/** A hub that records what it was asked to deliver, and can refuse once. */
class RecordingHub {
  delivered: string[] = [];
  failNext = false;

  async broadcastAuthorized(_roomId: string, frame: { type: string; event: { eventId: string } }): Promise<number> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("DELIVERY_FAILED");
    }
    this.delivered.push(frame.event.eventId);
    return 4;
  }

  async broadcastProjectionAuthorized(): Promise<number> {
    return 0;
  }
}

async function commitMessages(count: number, prefix: string): Promise<string[]> {
  const events = new RoomEventRepository(pool, createCoreEventPayloadRegistry(), systemClock);
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const event = await events.transact(roomId, async (ctx) => ctx.append({
      type: "message.added",
      actorId,
      actorKind: "human",
      actorRole: "student",
      revision: 1,
      operation: "add",
      eventTime: new Date(),
      causationId: randomUUID(),
      correlationId: randomUUID(),
      payload: { messageId: randomUUID(), text: `${prefix}-${index}`, replyTo: null, mentions: [], mediaIds: [] },
    }));
    ids.push(event.eventId);
  }
  return ids;
}

// The pool is built through the server's own factory so this suite resolves
// `pg` exactly the way the code under test does.
beforeAll(() => { pool = createDatabasePool(databaseUrl); });
afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await resetBusinessTables(databaseUrl!);
  const room = await seedLifecycleRoom(pool);
  roomId = room.roomId;
  await pool.query("UPDATE classroom_room SET status='open' WHERE room_id=$1", [roomId]);
  const member = await pool.query<{ actor_id: string }>(
    "SELECT actor_id FROM room_member WHERE room_id=$1 ORDER BY seat_index LIMIT 1",
    [roomId],
  );
  actorId = member.rows[0]!.actor_id;
});

afterEach(async () => { await resetBusinessTables(databaseUrl!); });

describe("event spine under faults", () => {
  it("loses nothing when the publisher dies with a full backlog", async () => {
    const committed = await commitMessages(6, "backlog");
    // Nothing has published yet: this is exactly the state a process that
    // crashed between commit and publish would leave behind.
    expect(await unpublishedOutbox(pool, roomId)).toBe(6);

    const hub = new RecordingHub();
    const publisher = new OutboxPublisher(pool, hub as never, "publisher-after-crash");
    let published = 0;
    while (published < 6) {
      const batch = await publisher.tick();
      if (batch === 0) break;
      published += batch;
    }

    expect(hub.delivered.sort()).toEqual([...committed].sort());
    expect(await unpublishedOutbox(pool, roomId)).toBe(0);
    expect(chaosVerdict({
      scenario: "publisher-crash-with-backlog",
      fault: "process lost before publish",
      committed: committed.length,
      delivered: hub.delivered.length,
      duplicated: hub.delivered.length - new Set(hub.delivered).size,
      lost: committed.length - new Set(hub.delivered).size,
    }).ok).toBe(true);
  });

  it("delivers each event once when two publishers race the same backlog", async () => {
    const committed = await commitMessages(8, "race");
    const first = new RecordingHub();
    const second = new RecordingHub();
    // `FOR UPDATE SKIP LOCKED` is the claim; two publishers running at once is
    // what proves it, and it is the ordinary state of a restart overlapping
    // the process it replaced.
    await Promise.all([
      new OutboxPublisher(pool, first as never, "publisher-a").tick(),
      new OutboxPublisher(pool, second as never, "publisher-b").tick(),
    ]);
    const all = [...first.delivered, ...second.delivered];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([...committed].sort());
  });

  it("returns a failed delivery to the backlog instead of dropping it", async () => {
    const committed = await commitMessages(3, "retry");
    const hub = new RecordingHub();
    hub.failNext = true;
    const publisher = new OutboxPublisher(pool, hub as never, "publisher-flaky");
    await publisher.tick();

    // One delivery failed, so that row is unpublished and available again.
    expect(hub.delivered.length).toBe(2);
    expect(await unpublishedOutbox(pool, roomId)).toBe(1);
    // The row is deliberately deferred, so a hot loop cannot spin on it.
    const available = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox_event WHERE room_id=$1 AND published_at IS NULL AND available_at > now()",
      [roomId],
    );
    expect(Number(available.rows[0]!.count)).toBe(1);
    expect(committed).toHaveLength(3);
  });

  it("does not republish an event the previous process already published", async () => {
    await commitMessages(4, "idempotent");
    const first = new RecordingHub();
    await new OutboxPublisher(pool, first as never, "publisher-before").tick();
    expect(await publishedOutbox(pool, roomId)).toBe(4);

    // A new process against the same database: published rows are not claimed
    // again, so a restart cannot show a student the same message twice.
    const second = new RecordingHub();
    const republished = await new OutboxPublisher(pool, second as never, "publisher-after").tick();
    expect(republished).toBe(0);
    expect(second.delivered).toEqual([]);
  });

  it("keeps the ledger contiguous under every fault above", async () => {
    await commitMessages(5, "contiguous");
    const hub = new RecordingHub();
    hub.failNext = true;
    await new OutboxPublisher(pool, hub as never, "publisher-mixed").tick();
    await new OutboxPublisher(pool, hub as never, "publisher-mixed-2").tick();

    const events = await committedEvents(pool, roomId);
    // Room sequence is the classroom's shared order. A gap would mean a client
    // could not tell whether it was behind or something was lost.
    expect(events.map((event) => event.roomSeq)).toEqual(events.map((_event, index) => index + 1));
    expect(new Set(events.map((event) => event.causationId)).size).toBe(events.length);
  });
});
