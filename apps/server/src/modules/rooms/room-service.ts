import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
  roomHttpContract,
  type AuthSession,
  type CreateRoomResponse,
  type JoinRoomResponse,
  type RoomDetails,
} from "@learning-orbit/contracts";
import type { Clock } from "../../clock.js";
import { inTransaction } from "../../db/transactions.js";
import { opaqueToken, tokenHash } from "../auth/crypto.js";
import {
  lockRoomCodeAllocationInTransaction,
  lockRoomInTransaction,
} from "./room-lock.js";
import { CodeHasher, makeRoomCode, makeSeatCode } from "./seat-codes.js";

const STUDENT_PSEUDONYMS = [
  "探索者 A",
  "探索者 B",
  "探索者 C",
  "探索者 D",
] as const;
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const ROOM_CODE_ATTEMPTS = 8;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RoomServiceErrorCode =
  | "ROOM_FORBIDDEN"
  | "JOIN_FORBIDDEN"
  | "ROOM_NOT_FOUND"
  | "ROOM_CODE_UNAVAILABLE";

export class RoomServiceError extends Error {
  constructor(readonly code: RoomServiceErrorCode) {
    super(code);
  }
}

export interface JoinedRoom {
  readonly response: JoinRoomResponse;
  readonly sessionToken: string;
}

export interface RoomCodeSource {
  roomCode(): string;
  seatCode(): string;
}

const secureRoomCodeSource: RoomCodeSource = {
  roomCode: makeRoomCode,
  seatCode: makeSeatCode,
};

interface LocatedRoom {
  room_id: string;
}

interface LockedRoom {
  room_id: string;
  status: "scheduled" | "open" | "paused" | "closed";
}

interface LockedMember {
  room_member_id: string;
  actor_id: string;
  pseudonym: string;
  code_hash: Buffer;
}

interface RoomDetailsRow {
  room_id: string;
  topic: string;
  status: "scheduled" | "open" | "paused" | "closed";
  duration_seconds: number;
  starts_at: Date | null;
  closes_at: Date | null;
  nova_actor_id: string;
  actor_id: string;
  pseudonym: string;
}

function uniqueUuid(used: Set<string>): string {
  let value = randomUUID();
  while (used.has(value)) value = randomUUID();
  used.add(value);
  return value;
}

function uniqueSeatCode(used: Set<string>, source: RoomCodeSource): string {
  let value = source.seatCode();
  while (used.has(value)) value = source.seatCode();
  used.add(value);
  return value;
}

export class RoomService {
  readonly #dummySeatHashes: readonly Buffer[];

  constructor(
    private readonly pool: Pool,
    private readonly codeHasher: CodeHasher,
    private readonly clock: Clock,
    private readonly codeSource: RoomCodeSource = secureRoomCodeSource,
  ) {
    this.#dummySeatHashes = Array.from(
      { length: STUDENT_PSEUDONYMS.length },
      (_, index) => this.codeHasher.hash(`learning-orbit-dummy-seat-${index}`),
    );
  }

  async createRoom(identity: AuthSession, value: unknown): Promise<CreateRoomResponse> {
    if (identity.role !== "teacher") throw new RoomServiceError("ROOM_FORBIDDEN");
    const input = roomHttpContract.parseCreateRoomRequest(value);
    return inTransaction(this.pool, async (tx) => {
      const usedActors = new Set<string>();
      const roomId = randomUUID();
      const novaActorId = uniqueUuid(usedActors);
      const rawRoomCode = await this.#insertRoom(
        tx, roomId, novaActorId, identity.teacherId, input.topic,
      );

      const usedSeatCodes = new Set<string>();
      const seatInvites = [];
      for (const [index, pseudonym] of STUDENT_PSEUDONYMS.entries()) {
        const roomMemberId = randomUUID();
        const actorId = uniqueUuid(usedActors);
        const rawSeatCode = uniqueSeatCode(usedSeatCodes, this.codeSource);
        await tx.query(
          `INSERT INTO room_member(
             room_member_id, actor_id, room_id, seat_index, pseudonym, code_hash
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [roomMemberId, actorId, roomId, index + 1, pseudonym, this.codeHasher.hash(rawSeatCode)],
        );
        seatInvites.push({ roomMemberId, actorId, pseudonym, code: rawSeatCode });
      }

      return roomHttpContract.parseCreateRoomResponse({
        room: {
          roomId,
          roomCode: rawRoomCode,
          status: "scheduled",
          durationSeconds: 2700,
          nova: {
            actorId: novaActorId,
            actorKind: "agent",
            actorRole: "socratic_facilitator",
            displayName: "Nova Agent",
          },
        },
        seatInvites,
      });
    });
  }

  async joinRoom(value: unknown): Promise<JoinedRoom> {
    const input = roomHttpContract.parseJoinRoomRequest(value);
    const roomCandidates = this.codeHasher.candidateHashes(input.roomCode);
    return inTransaction(this.pool, async (tx) => {
      const located = await tx.query<LocatedRoom>(
        `SELECT room_id FROM classroom_room
         WHERE room_code_hash = ANY($1::bytea[])
         ORDER BY room_id LIMIT 2`,
        [roomCandidates],
      );
      const hasUniqueRoom = located.rows.length === 1;
      const roomId = hasUniqueRoom ? located.rows[0]!.room_id : randomUUID();

      await lockRoomInTransaction(tx, roomId);
      const room = await tx.query<LockedRoom>(
        `SELECT room_id, status FROM classroom_room
         WHERE room_id = $1 AND room_code_hash = ANY($2::bytea[])
         FOR UPDATE`,
        [roomId, roomCandidates],
      );
      const lockedRoom = room.rows[0];
      const members = await this.#lockMembers(tx, roomId);
      const matches: LockedMember[] = [];
      for (let index = 0; index < STUDENT_PSEUDONYMS.length; index += 1) {
        const member = members[index];
        const stored = member?.code_hash ?? this.#dummySeatHashes[index]!;
        if (this.codeHasher.verify(input.seatCode, stored) && member) matches.push(member);
      }
      if (
        !hasUniqueRoom
        || !lockedRoom
        || members.length !== STUDENT_PSEUDONYMS.length
        || matches.length !== 1
        || !["scheduled", "open"].includes(lockedRoom.status)
      ) throw new RoomServiceError("JOIN_FORBIDDEN");

      const member = matches[0]!;
      const now = this.clock.now();
      await tx.query(
        `UPDATE auth_session SET revoked_at = $2
         WHERE principal_kind = 'student' AND room_member_id = $1
           AND revoked_at IS NULL`,
        [member.room_member_id, now],
      );
      const sessionToken = opaqueToken();
      await tx.query(
        `INSERT INTO auth_session(
           session_id, token_hash, principal_kind, room_member_id,
           expires_at, created_at
         ) VALUES ($1, $2, 'student', $3, $4, $5)`,
        [
          randomUUID(), tokenHash(sessionToken), member.room_member_id,
          new Date(now.getTime() + SESSION_DURATION_MS), now,
        ],
      );
      return {
        sessionToken,
        response: roomHttpContract.parseJoinRoomResponse({
          roomMemberId: member.room_member_id,
          actorId: member.actor_id,
          pseudonym: member.pseudonym,
        }),
      };
    });
  }

  async getRoom(identity: AuthSession, roomId: string): Promise<RoomDetails> {
    if (!UUID_PATTERN.test(roomId)) throw new RoomServiceError("ROOM_NOT_FOUND");
    if (identity.role === "student" && identity.roomId !== roomId) {
      throw new RoomServiceError("ROOM_NOT_FOUND");
    }
    const accessSql = identity.role === "teacher"
      ? "r.teacher_id = $2"
      : "r.room_id = $2";
    const accessId = identity.role === "teacher" ? identity.teacherId : identity.roomId;
    const result = await this.pool.query<RoomDetailsRow>(
      `SELECT r.room_id, r.topic, r.status, r.duration_seconds,
              r.starts_at, r.closes_at, r.nova_actor_id,
              m.actor_id, m.pseudonym
       FROM classroom_room r
       JOIN room_member m ON m.room_id = r.room_id
       WHERE r.room_id = $1 AND ${accessSql}
       ORDER BY m.seat_index`,
      [roomId, accessId],
    );
    if (result.rows.length !== STUDENT_PSEUDONYMS.length) {
      throw new RoomServiceError("ROOM_NOT_FOUND");
    }
    const room = result.rows[0]!;
    return roomHttpContract.parseRoomDetails({
      roomId: room.room_id,
      topic: room.topic,
      status: room.status,
      durationSeconds: room.duration_seconds,
      startsAt: room.starts_at?.toISOString() ?? null,
      closesAt: room.closes_at?.toISOString() ?? null,
      nova: {
        actorId: room.nova_actor_id,
        actorKind: "agent",
        actorRole: "socratic_facilitator",
        displayName: "Nova Agent",
      },
      participants: result.rows.map(({ actor_id: actorId, pseudonym }) => ({
        actorId,
        pseudonym,
        actorKind: "human",
        actorRole: "student",
      })),
    });
  }

  async #lockMembers(tx: PoolClient, roomId: string): Promise<LockedMember[]> {
    const result = await tx.query<LockedMember>(
      `SELECT room_member_id, actor_id, pseudonym, code_hash
       FROM room_member WHERE room_id = $1
       ORDER BY room_member_id FOR UPDATE`,
      [roomId],
    );
    return result.rows;
  }

  async #insertRoom(
    tx: PoolClient,
    roomId: string,
    novaActorId: string,
    teacherId: string,
    topic: string,
  ): Promise<string> {
    for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt += 1) {
      const rawRoomCode = this.codeSource.roomCode();
      const normalizedRoomCode = rawRoomCode.trim().toUpperCase();
      await lockRoomCodeAllocationInTransaction(tx, normalizedRoomCode);
      const currentHash = this.codeHasher.hash(rawRoomCode);
      const readableHashes = this.codeHasher.candidateHashes(rawRoomCode);
      const inserted = await tx.query(
        `INSERT INTO classroom_room(
           room_id, room_code_hash, nova_actor_id, teacher_id, topic
         )
         SELECT $1, $2, $3, $4, $5
         WHERE NOT EXISTS (
           SELECT 1 FROM classroom_room
           WHERE room_code_hash = ANY($6::bytea[])
         )
         ON CONFLICT (room_code_hash) DO NOTHING
         RETURNING room_id`,
        [roomId, currentHash, novaActorId, teacherId, topic, readableHashes],
      );
      if (inserted.rowCount === 1) return rawRoomCode;
    }
    throw new RoomServiceError("ROOM_CODE_UNAVAILABLE");
  }
}
