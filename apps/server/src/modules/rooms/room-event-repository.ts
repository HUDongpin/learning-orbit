import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { Pool, PoolClient } from "pg";

import {
  parseRoomEventEnvelope,
  type EventPayloadRegistry,
  type RoomEventEnvelope,
} from "@learning-orbit/contracts";
import { systemClock, type Clock } from "../../clock.js";
import { inTransaction } from "../../db/transactions.js";
import { RoomError } from "./errors.js";
import { lockRoomInTransaction } from "./room-lock.js";

const CANONICAL_OUTBOX_TOPIC = "learning_orbit.room_event.v1";
const MAX_JSON_DEPTH = 32;
const MAX_JSON_UNITS = 10_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DRAFT_KEYS = new Set([
  "type",
  "actorId",
  "actorKind",
  "actorRole",
  "revision",
  "operation",
  "eventTime",
  "causationId",
  "correlationId",
  "payload",
]);

type ServerAssignedEventField =
  | "eventId"
  | "schemaVersion"
  | "roomId"
  | "roomSeq"
  | "eventTime"
  | "ingestTime";

export type RoomEventDraft = Omit<RoomEventEnvelope, ServerAssignedEventField>
  & { readonly eventTime: Date };

export interface LockedRoomSnapshot {
  readonly room_id: string;
  readonly nova_actor_id: string;
  readonly teacher_id: string;
  readonly topic: string;
  readonly status: "scheduled" | "open" | "paused" | "closed";
  readonly duration_seconds: number;
  readonly starts_at: string | null;
  readonly closes_at: string | null;
  readonly closed_at: string | null;
  readonly next_room_seq: number;
  readonly created_at: string;
}

export interface RoomEventTransactionContext {
  readonly client: PoolClient;
  readonly room: LockedRoomSnapshot;
  readonly append: (draft: unknown) => Promise<RoomEventEnvelope>;
  readonly findByCausation: (causationId: string) => Promise<RoomEventEnvelope | null>;
}

interface LockedRoomRow {
  room_id: string;
  nova_actor_id: string;
  teacher_id: string;
  topic: string;
  status: "scheduled" | "open" | "paused" | "closed";
  duration_seconds: number;
  starts_at: Date | null;
  closes_at: Date | null;
  closed_at: Date | null;
  next_room_seq: string;
  created_at: Date;
}

interface StoredEventRow {
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
  payload: unknown;
  outbox_room_id: string | null;
  outbox_room_seq: string | null;
  topic: string | null;
  envelope: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

interface JsonCloneState {
  readonly seen: WeakSet<object>;
  units: number;
}

function consumeJsonBudget(state: JsonCloneState): void {
  state.units += 1;
  if (state.units > MAX_JSON_UNITS) throw new Error("INVALID_PLAIN_JSON");
}

function clonePlainJsonData(
  value: unknown,
  state: JsonCloneState = { seen: new WeakSet(), units: 0 },
  depth = 0,
): unknown {
  consumeJsonBudget(state);
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("INVALID_PLAIN_JSON");
    return value;
  }
  if (typeof value !== "object") throw new Error("INVALID_PLAIN_JSON");
  if (
    depth > MAX_JSON_DEPTH
    || state.seen.has(value)
  ) throw new Error("INVALID_PLAIN_JSON");
  state.seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error("INVALID_PLAIN_JSON");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor
      || !("value" in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || lengthDescriptor.value > MAX_JSON_UNITS
    ) throw new Error("INVALID_PLAIN_JSON");
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) throw new Error("INVALID_PLAIN_JSON");
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new Error("INVALID_PLAIN_JSON");
      }
      consumeJsonBudget(state);
      copy.push(clonePlainJsonData(descriptor.value, state, depth + 1));
    }
    if (keys.some((key) => (
      typeof key !== "string"
      || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))
      || (key !== "length" && Number(key) >= length)
    ))) throw new Error("INVALID_PLAIN_JSON");
    return copy;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("INVALID_PLAIN_JSON");
  }
  const copy: Record<string, unknown> = {};
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_JSON_UNITS) throw new Error("INVALID_PLAIN_JSON");
  for (const key of keys) {
    if (typeof key !== "string") throw new Error("INVALID_PLAIN_JSON");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error("INVALID_PLAIN_JSON");
    }
    consumeJsonBudget(state);
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: clonePlainJsonData(descriptor.value, state, depth + 1),
      writable: true,
    });
  }
  return copy;
}

function invalidCommand(): never {
  throw new RoomError("INVALID_COMMAND");
}

function safePositiveInteger(value: string, errorCode: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(errorCode);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(errorCode);
  return parsed;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function dateText(value: Date | null, errorCode: string): string | null {
  if (value === null) return null;
  if (!validDate(value)) throw new Error(errorCode);
  return value.toISOString();
}

function immutableDraftMatches(
  stored: RoomEventEnvelope,
  candidate: RoomEventEnvelope,
): boolean {
  return stored.type === candidate.type
    && stored.actorId === candidate.actorId
    && stored.actorKind === candidate.actorKind
    && stored.actorRole === candidate.actorRole
    && stored.revision === candidate.revision
    && stored.operation === candidate.operation
    && stored.eventTime === candidate.eventTime
    && stored.causationId === candidate.causationId
    && stored.correlationId === candidate.correlationId
    && isDeepStrictEqual(stored.payload, candidate.payload);
}

function parseStoredEvent(
  row: StoredEventRow,
  payloads: EventPayloadRegistry,
): RoomEventEnvelope {
  if (
    row.topic !== CANONICAL_OUTBOX_TOPIC
    || !validDate(row.event_time)
    || !validDate(row.ingest_time)
    || row.outbox_room_id !== row.room_id
  ) throw new Error("INVALID_STORED_ROOM_EVENT");

  const roomSeq = safePositiveInteger(row.room_seq, "INVALID_STORED_ROOM_EVENT");
  if (
    row.outbox_room_seq === null
    || safePositiveInteger(row.outbox_room_seq, "INVALID_STORED_ROOM_EVENT") !== roomSeq
  ) throw new Error("INVALID_STORED_ROOM_EVENT");

  let parsed: RoomEventEnvelope;
  try {
    parsed = parseRoomEventEnvelope(row.envelope);
    payloads.assert(parsed.type, parsed.payload);
  } catch {
    throw new Error("INVALID_STORED_ROOM_EVENT");
  }

  const relationalEnvelope = {
    eventId: row.event_id,
    schemaVersion: row.schema_version,
    roomId: row.room_id,
    roomSeq,
    type: row.type,
    actorId: row.actor_id,
    actorKind: row.actor_kind,
    actorRole: row.actor_role,
    revision: row.revision,
    operation: row.operation,
    eventTime: row.event_time.toISOString(),
    ingestTime: row.ingest_time.toISOString(),
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    payload: row.payload,
  };
  if (!isDeepStrictEqual(parsed, relationalEnvelope)) {
    throw new Error("INVALID_STORED_ROOM_EVENT");
  }
  return parsed;
}

function roomSnapshot(row: LockedRoomRow): LockedRoomSnapshot {
  if (!validDate(row.created_at)) throw new Error("INVALID_STORED_ROOM");
  return Object.freeze({
    room_id: row.room_id,
    nova_actor_id: row.nova_actor_id,
    teacher_id: row.teacher_id,
    topic: row.topic,
    status: row.status,
    duration_seconds: row.duration_seconds,
    starts_at: dateText(row.starts_at, "INVALID_STORED_ROOM"),
    closes_at: dateText(row.closes_at, "INVALID_STORED_ROOM"),
    closed_at: dateText(row.closed_at, "INVALID_STORED_ROOM"),
    next_room_seq: safePositiveInteger(row.next_room_seq, "ROOM_SEQUENCE_OUT_OF_RANGE"),
    created_at: row.created_at.toISOString(),
  });
}

const storedEventSelect = `
  SELECT e.event_id, e.room_id, e.room_seq, e.schema_version, e.type,
         e.actor_id, e.actor_kind, e.actor_role, e.revision, e.operation,
         e.event_time, e.ingest_time, e.causation_id, e.correlation_id,
         e.payload, o.room_id AS outbox_room_id,
         o.room_seq AS outbox_room_seq, o.topic, o.envelope
  FROM room_event e
  LEFT JOIN outbox_event o ON o.event_id = e.event_id`;

export class RoomEventRepository {
  constructor(
    private readonly pool: Pool,
    private readonly payloads: EventPayloadRegistry,
    private readonly clock: Clock = systemClock,
  ) {}

  async transact<T>(
    roomId: string,
    work: (context: RoomEventTransactionContext) => Promise<T>,
  ): Promise<T> {
    if (!UUID_PATTERN.test(roomId)) throw new RoomError("FORBIDDEN");
    return inTransaction(this.pool, async (client) => {
      await lockRoomInTransaction(client, roomId);
      const result = await client.query<LockedRoomRow>(
        `SELECT room_id, nova_actor_id, teacher_id, topic,
                status, duration_seconds, starts_at, closes_at, closed_at,
                next_room_seq, created_at
         FROM classroom_room WHERE room_id = $1 FOR UPDATE`,
        [roomId],
      );
      const locked = result.rows[0];
      if (!locked) throw new RoomError("FORBIDDEN");
      const room = roomSnapshot(locked);
      let nextRoomSeq = room.next_room_seq;
      let operationFailure: unknown;
      let operationTail: Promise<void> = Promise.resolve();
      let acceptingOperations = true;

      const findOneByCausation = async (
        causationId: string,
      ): Promise<RoomEventEnvelope | null> => {
        if (!UUID_PATTERN.test(causationId)) invalidCommand();
        const existing = await client.query<StoredEventRow>(
          `${storedEventSelect}
           WHERE e.room_id = $1 AND e.causation_id = $2`,
          [roomId, causationId],
        );
        const row = existing.rows[0];
        return row ? parseStoredEvent(row, this.payloads) : null;
      };

      const appendOne = async (draft: unknown): Promise<RoomEventEnvelope> => {
        if (operationFailure !== undefined) throw operationFailure;
        const candidate = this.#validateDraft(roomId, nextRoomSeq, draft);
        const prior = await findOneByCausation(candidate.causationId);
        if (prior) {
          if (!immutableDraftMatches(prior, candidate)) invalidCommand();
          return prior;
        }

        try {
          await client.query(
            `INSERT INTO room_event(
               event_id, room_id, room_seq, schema_version, type,
               actor_id, actor_kind, actor_role, revision, operation,
               event_time, ingest_time, causation_id, correlation_id, payload
             ) VALUES(
               $1, $2, $3, $4, $5,
               $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15
             )`,
            [
              candidate.eventId,
              candidate.roomId,
              candidate.roomSeq,
              candidate.schemaVersion,
              candidate.type,
              candidate.actorId,
              candidate.actorKind,
              candidate.actorRole,
              candidate.revision,
              candidate.operation,
              candidate.eventTime,
              candidate.ingestTime,
              candidate.causationId,
              candidate.correlationId,
              candidate.payload,
            ],
          );
          await client.query(
            `INSERT INTO outbox_event(event_id, room_id, room_seq, envelope)
             VALUES($1, $2, $3, $4)`,
            [candidate.eventId, candidate.roomId, candidate.roomSeq, candidate],
          );
          const advanced = await client.query(
            `UPDATE classroom_room SET next_room_seq = $2
             WHERE room_id = $1 AND next_room_seq = $3`,
            [roomId, nextRoomSeq + 1, nextRoomSeq],
          );
          if (advanced.rowCount !== 1) throw new Error("ROOM_SEQUENCE_ADVANCE_FAILED");
        } catch {
          throw new Error("ROOM_EVENT_APPEND_FAILED");
        }
        nextRoomSeq += 1;
        return candidate;
      };

      const schedule = <Value>(operation: () => Promise<Value>): Promise<Value> => {
        if (!acceptingOperations) {
          return Promise.reject(new Error("ROOM_EVENT_TRANSACTION_CLOSED"));
        }
        const result = operationTail.then(operation);
        operationTail = result.then(
          () => undefined,
          (error: unknown) => { operationFailure = error; },
        );
        return result;
      };
      const append = (draft: unknown): Promise<RoomEventEnvelope> => (
        schedule(() => appendOne(draft))
      );
      const findByCausation = (causationId: string): Promise<RoomEventEnvelope | null> => (
        schedule(() => findOneByCausation(causationId))
      );

      const workOutcome = await Promise.resolve()
        .then(() => work({ client, room, append, findByCausation }))
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      acceptingOperations = false;
      await operationTail;
      if (!workOutcome.ok) throw workOutcome.error;
      if (operationFailure !== undefined) throw operationFailure;
      return workOutcome.value;
    });
  }

  async eventsAfter(
    roomId: string,
    afterSeq: number,
    limit: number,
  ): Promise<readonly RoomEventEnvelope[]> {
    if (
      !UUID_PATTERN.test(roomId)
      || !Number.isSafeInteger(afterSeq)
      || afterSeq < 0
      || !Number.isSafeInteger(limit)
      || limit < 1
      || limit > 500
    ) invalidCommand();

    const result = await this.pool.query<StoredEventRow>(
      `${storedEventSelect}
       WHERE e.room_id = $1 AND e.room_seq > $2
       ORDER BY e.room_seq ASC
       LIMIT $3`,
      [roomId, afterSeq, limit],
    );
    return result.rows.map((row) => parseStoredEvent(row, this.payloads));
  }

  #validateDraft(roomId: string, roomSeq: number, draft: unknown): RoomEventEnvelope {
    if (!isPlainRecord(draft)) invalidCommand();
    const keys = Reflect.ownKeys(draft);
    if (
      keys.length !== DRAFT_KEYS.size
      || keys.some((key) => {
        if (typeof key !== "string" || !DRAFT_KEYS.has(key)) return true;
        const descriptor = Object.getOwnPropertyDescriptor(draft, key);
        return !descriptor || !descriptor.enumerable || !("value" in descriptor);
      })
    ) invalidCommand();
    if (typeof draft.type !== "string") invalidCommand();
    let payload: unknown;
    try {
      payload = clonePlainJsonData(draft.payload);
    } catch {
      invalidCommand();
    }
    if (!validDate(draft.eventTime)) invalidCommand();
    const ingestTime = this.clock.now();
    if (!validDate(ingestTime)) throw new Error("INVALID_CLOCK");

    const envelope = {
      eventId: randomUUID(),
      schemaVersion: 1,
      roomId,
      roomSeq,
      type: draft.type,
      actorId: draft.actorId,
      actorKind: draft.actorKind,
      actorRole: draft.actorRole,
      revision: draft.revision,
      operation: draft.operation,
      eventTime: draft.eventTime.toISOString(),
      ingestTime: ingestTime.toISOString(),
      causationId: draft.causationId,
      correlationId: draft.correlationId,
      payload,
    };
    try {
      const parsed = parseRoomEventEnvelope(envelope);
      this.payloads.assert(parsed.type, parsed.payload);
      return parsed;
    } catch (error) {
      if (error instanceof RoomError) throw error;
      invalidCommand();
    }
  }
}
