import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createCoreEventPayloadRegistry,
  type EventPayloadRegistry,
} from "@learning-orbit/contracts";
import type { Clock } from "../../src/clock.js";
import { runMigrations } from "../../src/db/migrate.js";
import { RoomError } from "../../src/modules/rooms/errors.js";
import {
  RoomEventRepository,
  type RoomEventDraft,
} from "../../src/modules/rooms/room-event-repository.js";
import { resetBusinessTables } from "../db/reset.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for room ledger tests");

const CANONICAL_TOPIC = "learning_orbit.room_event.v1";
const EVENT_TIME = new Date("2026-08-28T09:00:00.000Z");
const INGEST_TIME = new Date("2026-08-28T09:00:01.000Z");
const pool = new Pool({ connectionString: databaseUrl, max: 24 });
const fixedClock: Clock = { now: () => new Date(INGEST_TIME) };

interface SeededRoom {
  readonly roomId: string;
  readonly teacherId: string;
  readonly novaActorId: string;
}

interface LedgerCounts {
  readonly events: number;
  readonly outbox: number;
  readonly nextRoomSeq: string;
}

function repository(
  registry: EventPayloadRegistry = createCoreEventPayloadRegistry(),
  clock: Clock = fixedClock,
): RoomEventRepository {
  return new RoomEventRepository(
    pool,
    registry,
    clock,
  );
}

async function query<T extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await pool.query<T>(text, [...values])).rows;
}

async function businessRowCount(): Promise<number> {
  const rows = await query<{ count: number }>(
    `SELECT (
      (SELECT count(*) FROM teacher_account)
      + (SELECT count(*) FROM magic_link)
      + (SELECT count(*) FROM classroom_room)
      + (SELECT count(*) FROM room_member)
      + (SELECT count(*) FROM auth_session)
      + (SELECT count(*) FROM room_event)
      + (SELECT count(*) FROM outbox_event)
      + (SELECT count(*) FROM worker_job)
      + (SELECT count(*) FROM worker_job_completion)
    )::int AS count`,
  );
  return rows[0]?.count ?? -1;
}

async function seedRoom(): Promise<SeededRoom> {
  const teacherId = randomUUID();
  const roomId = randomUUID();
  const novaActorId = randomUUID();
  await query(
    `INSERT INTO teacher_account(teacher_id, email)
     VALUES($1, $2)`,
    [teacherId, `teacher-${teacherId}@example.test`],
  );
  await query(
    `INSERT INTO classroom_room(
       room_id, room_code_hash, nova_actor_id, teacher_id, topic
     ) VALUES($1, decode($2, 'hex'), $3, $4, '生態系統')`,
    [roomId, randomUUID().replaceAll("-", ""), novaActorId, teacherId],
  );
  return { roomId, teacherId, novaActorId };
}

function openedDraft(
  room: SeededRoom,
  causationId = randomUUID(),
): RoomEventDraft {
  return {
    type: "room.opened",
    actorId: room.teacherId,
    actorKind: "human",
    actorRole: "teacher",
    revision: 1,
    operation: "add",
    eventTime: new Date(EVENT_TIME),
    causationId,
    correlationId: randomUUID(),
    payload: {
      startsAt: EVENT_TIME.toISOString(),
      closesAt: "2026-08-28T09:45:00.000Z",
    },
  };
}

function closedDraft(
  room: SeededRoom,
  causationId = randomUUID(),
): RoomEventDraft {
  return {
    type: "room.closed",
    actorId: room.teacherId,
    actorKind: "human",
    actorRole: "teacher",
    revision: 1,
    operation: "add",
    eventTime: new Date("2026-08-28T09:45:00.000Z"),
    causationId,
    correlationId: randomUUID(),
    payload: { closedAt: "2026-08-28T09:45:00.000Z" },
  };
}

function extensionDraft(room: SeededRoom, causationId = randomUUID()) {
  return {
    type: "analytics.review.recorded.v1",
    actorId: room.teacherId,
    actorKind: "human",
    actorRole: "teacher",
    revision: 1,
    operation: "add",
    eventTime: new Date(EVENT_TIME),
    causationId,
    correlationId: randomUUID(),
    payload: { changeKind: "review" },
  };
}

async function append(roomId: string, draft: unknown) {
  return repository().transact(roomId, ({ append: appendEvent }) => appendEvent(draft));
}

async function counts(roomId: string): Promise<LedgerCounts> {
  const rows = await query<LedgerCounts>(
    `SELECT
       (SELECT count(*)::int FROM room_event WHERE room_id = $1) AS events,
       (SELECT count(*)::int FROM outbox_event WHERE room_id = $1) AS outbox,
       next_room_seq AS "nextRoomSeq"
     FROM classroom_room WHERE room_id = $1`,
    [roomId],
  );
  const result = rows[0];
  if (!result) throw new Error("EXPECTED_SEEDED_ROOM");
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

beforeAll(async () => runMigrations(databaseUrl, "infra/postgres/migrations"));

beforeEach(async () => {
  await resetBusinessTables(databaseUrl);
  expect(await businessRowCount()).toBe(0);
});

afterEach(async () => {
  await pool.query(
    "ALTER TABLE outbox_event DROP CONSTRAINT IF EXISTS ledger_test_reject_topic",
  );
  await resetBusinessTables(databaseUrl);
  expect(await businessRowCount()).toBe(0);
});

afterAll(async () => pool.end());

describe("atomic RoomEvent ledger and outbox", () => {
  it("allocates from one, deduplicates from the database, and writes one outbox per event", async () => {
    const room = await seedRoom();
    const causationId = randomUUID();
    const draft = openedDraft(room, causationId);
    const first = await append(room.roomId, draft);

    const independentRepository = repository();
    const duplicate = await independentRepository.transact(
      room.roomId,
      ({ append: appendEvent }) => appendEvent({ ...draft }),
    );
    const second = await append(room.roomId, closedDraft(room));

    expect([first.roomSeq, duplicate.roomSeq, second.roomSeq]).toEqual([1, 1, 2]);
    expect(duplicate).toEqual(first);
    expect(duplicate.eventId).toBe(first.eventId);
    expect(await counts(room.roomId)).toEqual({
      events: 2,
      outbox: 2,
      nextRoomSeq: "3",
    });
    const rows = await query<{ room_seq: string; topic: string }>(
      `SELECT room_seq, topic FROM outbox_event
       WHERE room_id = $1 ORDER BY room_seq`,
      [room.roomId],
    );
    expect(rows).toEqual([
      { room_seq: "1", topic: CANONICAL_TOPIC },
      { room_seq: "2", topic: CANONICAL_TOPIC },
    ]);
  });

  it("finds causation only through the locked transaction and validates stored authority", async () => {
    const room = await seedRoom();
    const causationId = randomUUID();
    const event = await append(room.roomId, openedDraft(room, causationId));
    const ledger = repository();

    await ledger.transact(room.roomId, async (context) => {
      expect(await context.findByCausation(causationId)).toEqual(event);
      expect(await context.findByCausation(randomUUID())).toBeNull();
    });
    await expect(ledger.transact(
      room.roomId,
      (context) => context.findByCausation("not-a-uuid"),
    )).rejects.toEqual(new RoomError("INVALID_COMMAND"));

    await pool.query(
      "UPDATE outbox_event SET room_seq = 99 WHERE event_id = $1",
      [event.eventId],
    );
    await expect(ledger.transact(
      room.roomId,
      (context) => context.findByCausation(causationId),
    )).rejects.toThrow("INVALID_STORED_ROOM_EVENT");
  });

  it("rejects a reused causation ID when any immutable draft field conflicts", async () => {
    const room = await seedRoom();
    const causationId = randomUUID();
    const original = openedDraft(room, causationId);
    await append(room.roomId, original);
    const conflicts: readonly Record<string, unknown>[] = [
      {
        ...original,
        type: "room.closed",
        payload: { closedAt: "2026-08-28T09:45:00.000Z" },
      },
      { ...original, actorId: randomUUID() },
      {
        ...original,
        actorKind: "agent",
        actorRole: "socratic_facilitator",
      },
      { ...original, revision: 2 },
      { ...original, operation: "revise" },
      { ...original, eventTime: new Date("2026-08-28T09:00:02.000Z") },
      { ...original, correlationId: randomUUID() },
      {
        ...original,
        payload: {
          startsAt: EVENT_TIME.toISOString(),
          closesAt: "2026-08-28T09:44:59.000Z",
        },
      },
    ];

    for (const conflict of conflicts) {
      await expect(append(room.roomId, conflict)).rejects.toEqual(
        new RoomError("INVALID_COMMAND"),
      );
      expect(await counts(room.roomId)).toEqual({
        events: 1,
        outbox: 1,
        nextRoomSeq: "2",
      });
    }
  });

  it("defaults extensions closed and persists one only after explicit registry registration", async () => {
    const room = await seedRoom();
    const draft = extensionDraft(room);
    await expect(repository().transact(
      room.roomId,
      ({ append: appendEvent }) => appendEvent(draft),
    )).rejects.toEqual(new RoomError("INVALID_COMMAND"));
    expect(await counts(room.roomId)).toEqual({
      events: 0,
      outbox: 0,
      nextRoomSeq: "1",
    });

    const registry = createCoreEventPayloadRegistry();
    registry.register("analytics.review.recorded.v1", {
      type: "object",
      additionalProperties: false,
      required: ["changeKind"],
      properties: { changeKind: { const: "review" } },
    });
    const ledger = repository(registry);
    const persisted = await ledger.transact(
      room.roomId,
      ({ append: appendEvent }) => appendEvent(draft),
    );

    expect(persisted).toMatchObject({
      type: "analytics.review.recorded.v1",
      roomSeq: 1,
      payload: { changeKind: "review" },
    });
    expect(await ledger.eventsAfter(room.roomId, 0, 10)).toEqual([persisted]);
    const outbox = await query<{ envelope: Record<string, unknown> }>(
      "SELECT envelope FROM outbox_event WHERE event_id = $1",
      [persisted.eventId],
    );
    expect(outbox).toEqual([{ envelope: persisted }]);
  });

  it("validates envelope grammar before consulting the injected payload allowlist", async () => {
    const room = await seedRoom();
    const registry = createCoreEventPayloadRegistry();
    const assertPayload = vi.spyOn(registry, "assert");
    const ledger = repository(registry);

    await expect(ledger.transact(
      room.roomId,
      ({ append: appendEvent }) => appendEvent({
        ...openedDraft(room),
        actorKind: "agent",
        actorRole: "teacher",
      }),
    )).rejects.toEqual(new RoomError("INVALID_COMMAND"));
    expect(assertPayload).not.toHaveBeenCalled();

    const event = await ledger.transact(
      room.roomId,
      ({ append: appendEvent }) => appendEvent(openedDraft(room)),
    );
    assertPayload.mockClear();
    await pool.query(
      `UPDATE outbox_event
       SET envelope = jsonb_set(envelope, '{actorKind}', '"agent"'::jsonb)
       WHERE event_id = $1`,
      [event.eventId],
    );
    await expect(ledger.eventsAfter(room.roomId, 0, 10)).rejects.toThrow(
      "INVALID_STORED_ROOM_EVENT",
    );
    expect(assertPayload).not.toHaveBeenCalled();
  });

  it("uses one READ COMMITTED transaction and appends a contiguous batch", async () => {
    const room = await seedRoom();
    const result = await repository().transact(room.roomId, async (context) => {
      const isolation = await context.client.query<{ transaction_isolation: string }>(
        "SHOW transaction_isolation",
      );
      expect(isolation.rows[0]?.transaction_isolation).toBe("read committed");
      expect(Object.isFrozen(context.room)).toBe(true);
      expect(context.room).toMatchObject({
        room_id: room.roomId,
        teacher_id: room.teacherId,
        nova_actor_id: room.novaActorId,
        next_room_seq: 1,
      });
      return Promise.all([
        context.append(openedDraft(room)),
        context.append(closedDraft(room)),
      ]);
    });

    expect(result.map(({ roomSeq }) => roomSeq)).toEqual([1, 2]);
    expect(await counts(room.roomId)).toEqual({
      events: 2,
      outbox: 2,
      nextRoomSeq: "3",
    });
  });

  it("linearizes twenty concurrent same-room appends without duplicate or missing sequence", async () => {
    const room = await seedRoom();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => append(room.roomId, openedDraft(room))),
    );
    const returned = results.map(({ roomSeq }) => roomSeq).sort((left, right) => left - right);
    const stored = await query<{ room_seq: string }>(
      "SELECT room_seq FROM room_event WHERE room_id = $1 ORDER BY room_seq",
      [room.roomId],
    );

    expect(returned).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(stored.map(({ room_seq }) => Number(room_seq))).toEqual(returned);
    expect(await counts(room.roomId)).toEqual({
      events: 20,
      outbox: 20,
      nextRoomSeq: "21",
    });
  });

  it("allows the same causation ID in different rooms", async () => {
    const firstRoom = await seedRoom();
    const secondRoom = await seedRoom();
    const causationId = randomUUID();
    const [first, second] = await Promise.all([
      append(firstRoom.roomId, openedDraft(firstRoom, causationId)),
      append(secondRoom.roomId, openedDraft(secondRoom, causationId)),
    ]);

    expect([first.roomSeq, second.roomSeq]).toEqual([1, 1]);
    expect(first.eventId).not.toBe(second.eventId);
    expect((await query("SELECT 1 FROM room_event WHERE causation_id = $1", [causationId])))
      .toHaveLength(2);
  });

  it("does not make a second room wait for held work in the first room", async () => {
    const firstRoom = await seedRoom();
    const secondRoom = await seedRoom();
    const entered = deferred<void>();
    const release = deferred<void>();
    const held = repository().transact(firstRoom.roomId, async ({ append: appendEvent }) => {
      entered.resolve();
      await release.promise;
      return appendEvent(openedDraft(firstRoom));
    });
    await entered.promise;

    const independent = append(secondRoom.roomId, openedDraft(secondRoom));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let failure: unknown;
    try {
      await Promise.race([
        independent,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("DIFFERENT_ROOM_APPEND_TIMED_OUT")),
            1_500,
          );
        }),
      ]);
    } catch (error) {
      failure = error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      release.resolve();
      const settled = await Promise.allSettled([held, independent]);
      if (failure === undefined) {
        const rejected = settled.find((result) => result.status === "rejected");
        if (rejected?.status === "rejected") failure = rejected.reason;
      }
    }
    if (failure !== undefined) throw failure;
  });

  it("rejects invalid payload, actor-role pair, date, and UUID without consuming a sequence", async () => {
    const room = await seedRoom();
    const valid = openedDraft(room);
    const invalidDrafts: readonly Record<string, unknown>[] = [
      { ...valid, payload: { startsAt: EVENT_TIME.toISOString() } },
      { ...valid, actorKind: "agent", actorRole: "teacher" },
      { ...valid, eventTime: new Date(Number.NaN) },
      { ...valid, actorId: "not-a-uuid" },
      { ...valid, causationId: "not-a-uuid" },
      { ...valid, correlationId: "not-a-uuid" },
      { ...valid, revision: 0 },
      { ...valid, operation: "replace" },
    ];

    for (const invalid of invalidDrafts) {
      await expect(append(room.roomId, invalid)).rejects.toMatchObject({
        code: "INVALID_COMMAND",
      });
      expect(await counts(room.roomId)).toEqual({
        events: 0,
        outbox: 0,
        nextRoomSeq: "1",
      });
    }
    expect((await append(room.roomId, openedDraft(room))).roomSeq).toBe(1);
  });

  it("rejects every client-owned envelope field instead of silently dropping it", async () => {
    const room = await seedRoom();
    const valid = openedDraft(room);
    const forbidden: Readonly<Record<string, unknown>> = {
      eventId: randomUUID(),
      schemaVersion: 1,
      roomId: room.roomId,
      roomSeq: 91,
      ingestTime: INGEST_TIME.toISOString(),
    };

    for (const [key, value] of Object.entries(forbidden)) {
      await expect(append(room.roomId, { ...valid, [key]: value })).rejects.toEqual(
        new RoomError("INVALID_COMMAND"),
      );
    }
    expect(await counts(room.roomId)).toEqual({
      events: 0,
      outbox: 0,
      nextRoomSeq: "1",
    });
  });

  it("rejects accessors, symbols, and non-enumerable draft properties without invoking getters", async () => {
    const room = await seedRoom();
    const withGetter = { ...openedDraft(room) };
    Object.defineProperty(withGetter, "type", {
      configurable: true,
      enumerable: true,
      get: () => { throw new Error("DRAFT_GETTER_MUST_NOT_RUN"); },
    });
    const withSymbol = { ...openedDraft(room), [Symbol("hidden")]: "not-json" };
    const withHidden = { ...openedDraft(room) };
    Object.defineProperty(withHidden, "type", {
      configurable: true,
      enumerable: false,
      value: "room.opened",
      writable: true,
    });

    for (const invalid of [withGetter, withSymbol, withHidden]) {
      await expect(append(room.roomId, invalid)).rejects.toEqual(
        new RoomError("INVALID_COMMAND"),
      );
    }
    expect(await counts(room.roomId)).toEqual({
      events: 0,
      outbox: 0,
      nextRoomSeq: "1",
    });
  });

  it("rejects nested payload accessors and custom prototypes before registry validation", async () => {
    const room = await seedRoom();
    let payloadGetterCalls = 0;
    let arrayGetterCalls = 0;
    const payloadWithGetter = {
      startsAt: EVENT_TIME.toISOString(),
      closesAt: "2026-08-28T09:45:00.000Z",
    };
    Object.defineProperty(payloadWithGetter, "closesAt", {
      configurable: true,
      enumerable: true,
      get: () => {
        payloadGetterCalls += 1;
        return "2026-08-28T09:45:00.000Z";
      },
    });
    const inheritedPayload = Object.assign(
      Object.create({ inherited: "not-json-own-data" }),
      openedDraft(room).payload,
    );
    const mentions = [room.teacherId];
    Object.defineProperty(mentions, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        arrayGetterCalls += 1;
        return room.teacherId;
      },
    });
    const messageWithArrayGetter = {
      type: "message.added",
      actorId: room.teacherId,
      actorKind: "human",
      actorRole: "teacher",
      revision: 1,
      operation: "add",
      eventTime: new Date(EVENT_TIME),
      causationId: randomUUID(),
      correlationId: randomUUID(),
      payload: {
        messageId: randomUUID(),
        text: "證據",
        replyTo: null,
        mentions,
        mediaIds: [],
      },
    };

    for (const invalid of [
      { ...openedDraft(room), payload: payloadWithGetter },
      { ...openedDraft(room), payload: inheritedPayload },
      messageWithArrayGetter,
    ]) {
      await expect(append(room.roomId, invalid)).rejects.toEqual(
        new RoomError("INVALID_COMMAND"),
      );
    }
    expect([payloadGetterCalls, arrayGetterCalls]).toEqual([0, 0]);
    expect(await counts(room.roomId)).toEqual({
      events: 0,
      outbox: 0,
      nextRoomSeq: "1",
    });
  });

  it("applies the JSON safety budget globally to every value and property", async () => {
    const room = await seedRoom();
    const registry = createCoreEventPayloadRegistry();
    registry.register("extension.budgeted", {
      type: "object",
      additionalProperties: false,
      required: ["values"],
      properties: {
        values: {
          type: "object",
          maxProperties: 4_999,
          additionalProperties: { type: "integer" },
        },
      },
    });
    const values = Object.fromEntries(
      Array.from({ length: 4_999 }, (_, index) => [`value${index}`, index]),
    );
    const draft = {
      ...extensionDraft(room),
      type: "extension.budgeted",
      payload: { values },
    };

    await expect(repository(registry).transact(
      room.roomId,
      ({ append: appendEvent }) => appendEvent(draft),
    )).rejects.toEqual(new RoomError("INVALID_COMMAND"));
    expect(await counts(room.roomId)).toEqual({
      events: 0,
      outbox: 0,
      nextRoomSeq: "1",
    });
  });

  it("rolls back event, outbox, and sequence when callback work throws", async () => {
    const room = await seedRoom();
    await expect(repository().transact(room.roomId, async ({ append: appendEvent }) => {
      await appendEvent(openedDraft(room));
      throw new Error("WORK_FAILED");
    })).rejects.toThrow("WORK_FAILED");

    expect(await counts(room.roomId)).toEqual({
      events: 0,
      outbox: 0,
      nextRoomSeq: "1",
    });
    expect((await append(room.roomId, openedDraft(room))).roomSeq).toBe(1);
  });

  it("settles an unawaited append before rolling back callback failure", async () => {
    const room = await seedRoom();
    let appendSettled: Promise<void> = Promise.resolve();
    await expect(repository().transact(room.roomId, ({ append: appendEvent }) => {
      appendSettled = appendEvent(openedDraft(room)).then(
        () => undefined,
        () => undefined,
      );
      throw new Error("WORK_FAILED_WITH_PENDING_APPEND");
    })).rejects.toThrow("WORK_FAILED_WITH_PENDING_APPEND");
    await appendSettled;

    expect(await counts(room.roomId)).toEqual({
      events: 0,
      outbox: 0,
      nextRoomSeq: "1",
    });
    expect((await append(room.roomId, openedDraft(room))).roomSeq).toBe(1);
  });

  it("closes a leaked append function as soon as its transaction callback returns", async () => {
    const room = await seedRoom();
    let escapedAppend: ((draft: unknown) => Promise<unknown>) | undefined;
    await repository().transact(room.roomId, async (context) => {
      escapedAppend = context.append;
    });
    if (!escapedAppend) throw new Error("EXPECTED_APPEND_REFERENCE");

    await expect(escapedAppend(openedDraft(room))).rejects.toEqual(
      new Error("ROOM_EVENT_TRANSACTION_CLOSED"),
    );
    expect(await counts(room.roomId)).toEqual({
      events: 0,
      outbox: 0,
      nextRoomSeq: "1",
    });
  });

  it("rolls back the event and sequence when the outbox insert is rejected", async () => {
    const room = await seedRoom();
    await pool.query(
      `ALTER TABLE outbox_event
       ADD CONSTRAINT ledger_test_reject_topic
       CHECK (topic <> 'learning_orbit.room_event.v1')`,
    );
    await expect(append(room.roomId, openedDraft(room))).rejects.toEqual(
      new Error("ROOM_EVENT_APPEND_FAILED"),
    );
    expect(await counts(room.roomId)).toEqual({
      events: 0,
      outbox: 0,
      nextRoomSeq: "1",
    });

    await pool.query("ALTER TABLE outbox_event DROP CONSTRAINT ledger_test_reject_topic");
    expect((await append(room.roomId, openedDraft(room))).roomSeq).toBe(1);
  });

  it("keeps returned envelope, room_event columns, and outbox envelope identical", async () => {
    const room = await seedRoom();
    const returned = await append(room.roomId, openedDraft(room));
    const rows = await query<{
      event_id: string;
      room_id: string;
      room_seq: string;
      schema_version: number;
      type: string;
      actor_id: string;
      actor_kind: string;
      actor_role: string;
      revision: number;
      operation: string;
      event_time: Date;
      ingest_time: Date;
      causation_id: string;
      correlation_id: string;
      payload: Record<string, unknown>;
      topic: string;
      envelope: Record<string, unknown>;
    }>(
      `SELECT e.*, o.topic, o.envelope
       FROM room_event e
       JOIN outbox_event o ON o.event_id = e.event_id
       WHERE e.event_id = $1`,
      [returned.eventId],
    );
    const row = rows[0];
    expect(row).toBeDefined();
    expect(row?.envelope).toEqual(returned);
    expect(row).toMatchObject({
      event_id: returned.eventId,
      room_id: returned.roomId,
      room_seq: String(returned.roomSeq),
      schema_version: returned.schemaVersion,
      type: returned.type,
      actor_id: returned.actorId,
      actor_kind: returned.actorKind,
      actor_role: returned.actorRole,
      revision: returned.revision,
      operation: returned.operation,
      causation_id: returned.causationId,
      correlation_id: returned.correlationId,
      payload: returned.payload,
      topic: CANONICAL_TOPIC,
    });
    expect(row?.event_time.toISOString()).toBe(returned.eventTime);
    expect(row?.ingest_time.toISOString()).toBe(returned.ingestTime);
  });

  it("reads validated envelopes in ascending sequence with bounded pagination", async () => {
    const room = await seedRoom();
    const ledger = repository();
    await ledger.transact(room.roomId, async ({ append: appendEvent }) => {
      for (let index = 0; index < 5; index += 1) {
        await appendEvent(openedDraft(room));
      }
    });

    expect((await ledger.eventsAfter(room.roomId, 0, 2)).map(({ roomSeq }) => roomSeq))
      .toEqual([1, 2]);
    expect((await ledger.eventsAfter(room.roomId, 2, 2)).map(({ roomSeq }) => roomSeq))
      .toEqual([3, 4]);
    expect((await ledger.eventsAfter(room.roomId, 4, 500)).map(({ roomSeq }) => roomSeq))
      .toEqual([5]);
    expect(await ledger.eventsAfter(room.roomId, 5, 10)).toEqual([]);
    expect(await ledger.eventsAfter(randomUUID(), 0, 10)).toEqual([]);
  });

  it("rejects unsafe history bounds before querying", async () => {
    const room = await seedRoom();
    const ledger = repository();
    const invalidBounds = [
      [-1, 1],
      [0.5, 1],
      [Number.MAX_SAFE_INTEGER + 1, 1],
      [0, 0],
      [0, 501],
      [0, 1.5],
    ] as const;
    for (const [afterSeq, limit] of invalidBounds) {
      await expect(ledger.eventsAfter(room.roomId, afterSeq, limit)).rejects.toMatchObject({
        code: "INVALID_COMMAND",
      });
    }
    await expect(ledger.eventsAfter("not-a-uuid", 0, 1)).rejects.toMatchObject({
      code: "INVALID_COMMAND",
    });
  });

  it("fails closed when stored outbox JSON is invalid or disagrees with relational columns", async () => {
    const room = await seedRoom();
    const ledger = repository();
    const event = await append(room.roomId, openedDraft(room));
    await pool.query(
      `UPDATE outbox_event
       SET envelope = jsonb_set(envelope, '{roomId}', to_jsonb($2::text))
       WHERE event_id = $1`,
      [event.eventId, randomUUID()],
    );

    await expect(ledger.eventsAfter(room.roomId, 0, 10)).rejects.toThrow(
      "INVALID_STORED_ROOM_EVENT",
    );
  });

  it("fails closed when outbox room identity or sequence disagrees with its event", async () => {
    const room = await seedRoom();
    const otherRoom = await seedRoom();
    const ledger = repository();
    const event = await append(room.roomId, openedDraft(room));

    await pool.query(
      "UPDATE outbox_event SET room_id = $2 WHERE event_id = $1",
      [event.eventId, otherRoom.roomId],
    );
    await expect(ledger.eventsAfter(room.roomId, 0, 10)).rejects.toThrow(
      "INVALID_STORED_ROOM_EVENT",
    );
    await pool.query(
      "UPDATE outbox_event SET room_id = $2, room_seq = 99 WHERE event_id = $1",
      [event.eventId, room.roomId],
    );
    await expect(ledger.eventsAfter(room.roomId, 0, 10)).rejects.toThrow(
      "INVALID_STORED_ROOM_EVENT",
    );
  });

  it("returns uniform FORBIDDEN for absent or malformed transaction room IDs", async () => {
    const ledger = repository();
    const work = () => Promise.resolve("must-not-run");
    for (const roomId of [randomUUID(), "not-a-uuid"]) {
      await expect(ledger.transact(roomId, work)).rejects.toEqual(new RoomError("FORBIDDEN"));
    }
  });
});
