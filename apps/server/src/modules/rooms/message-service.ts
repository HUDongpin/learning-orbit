import { randomUUID } from "node:crypto";
import type { AuthSession, RoomCommand, RoomEventEnvelope } from "@learning-orbit/contracts";
import { RoomError } from "./errors.js";
import type { RoomEventRepository } from "./room-event-repository.js";
import type { AttachmentValidator } from "./attachment-validator.js";
import { noAttachments } from "./attachment-validator.js";
import type { Clock } from "../../clock.js";

type MessageRow = {
  actor_id: string;
  actor_kind: "human" | "agent" | "system";
  revision: number;
  operation: "add" | "revise" | "retract";
  payload: Record<string, unknown>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function arrayOfStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && UUID.test(item));
}

function readUuidArray(payload: Record<string, unknown>, key: string, max: number): string[] {
  if (!Object.hasOwn(payload, key)) return [];
  const value = payload[key];
  if (!arrayOfStrings(value) || value.length > max) throw new RoomError("INVALID_COMMAND");
  return value;
}

function commandType(command: RoomCommand, expected: RoomCommand["type"]): void {
  if (command.type !== expected || !UUID.test(command.commandId) || !UUID.test(command.roomId)) {
    throw new RoomError("INVALID_COMMAND");
  }
}

export class MessageService {
  constructor(
    private readonly ledger: RoomEventRepository,
    private readonly attachments: AttachmentValidator = noAttachments,
    private readonly clock?: Clock,
  ) {}

  #now(): Date {
    const value = this.clock?.now() ?? new Date();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("INVALID_CLOCK");
    return value;
  }

  async #authorizeStudent(
    ctx: Parameters<Parameters<RoomEventRepository["transact"]>[1]>[0],
    principal: AuthSession,
    sessionId?: string,
  ): Promise<void> {
    if (principal.role !== "student" || principal.roomId !== ctx.room.room_id) throw new RoomError("FORBIDDEN");
    const result = sessionId
      ? await ctx.client.query<{ actor_id: string }>(
        `SELECT m.actor_id FROM auth_session s
         JOIN room_member m ON m.room_member_id = s.room_member_id
         WHERE s.session_id = $1 AND s.principal_kind = 'student'
           AND s.revoked_at IS NULL AND s.expires_at > transaction_timestamp()
           AND m.room_id = $2 AND m.room_member_id = $3 AND m.actor_id = $4`,
        [sessionId, ctx.room.room_id, principal.roomMemberId, principal.actorId],
      )
      : await ctx.client.query<{ actor_id: string }>(
        `SELECT actor_id FROM room_member
         WHERE room_id = $1 AND room_member_id = $2 AND actor_id = $3`,
        [ctx.room.room_id, principal.roomMemberId, principal.actorId],
      );
    if (result.rowCount !== 1) throw new RoomError("FORBIDDEN");
  }

  #authorizeTeacher(
    ctx: Parameters<Parameters<RoomEventRepository["transact"]>[1]>[0],
    principal: AuthSession,
    sessionId?: string,
  ): void {
    if (principal.role !== "teacher" || principal.teacherId !== ctx.room.teacher_id || principal.actorId !== ctx.room.teacher_id) {
      throw new RoomError("FORBIDDEN");
    }
  }

  async #assertTeacherSession(
    ctx: Parameters<Parameters<RoomEventRepository["transact"]>[1]>[0],
    principal: AuthSession,
    sessionId?: string,
  ): Promise<void> {
    this.#authorizeTeacher(ctx, principal, sessionId);
    if (!sessionId) return;
    if (principal.role !== "teacher") throw new RoomError("FORBIDDEN");
    const result = await ctx.client.query(
      `SELECT 1 FROM auth_session
       WHERE session_id = $1 AND principal_kind = 'teacher'
         AND teacher_id = $2 AND revoked_at IS NULL
         AND expires_at > transaction_timestamp()`,
      [sessionId, principal.teacherId],
    );
    if (result.rowCount !== 1) throw new RoomError("FORBIDDEN");
  }

  async #latestMessage(
    ctx: Parameters<Parameters<RoomEventRepository["transact"]>[1]>[0],
    messageId: string,
  ): Promise<MessageRow | null> {
    if (!UUID.test(messageId)) throw new RoomError("MESSAGE_NOT_FOUND");
    const result = await ctx.client.query<MessageRow>(
      `SELECT actor_id, actor_kind, revision, operation, payload
       FROM room_event
       WHERE room_id = $1 AND payload->>'messageId' = $2
       ORDER BY revision DESC, room_seq DESC
       LIMIT 1`,
      [ctx.room.room_id, messageId],
    );
    return result.rows[0] ?? null;
  }

  #retry(
    existing: RoomEventEnvelope | null,
    expectedType: "message.added" | "message.revised" | "message.retracted",
    actorId: string,
  ): RoomEventEnvelope | null {
    if (!existing) return null;
    if (
      existing.type !== expectedType || existing.actorId !== actorId
      || existing.actorKind !== "human" || !["student", "teacher"].includes(existing.actorRole)
    ) throw new RoomError("INVALID_COMMAND");
    return existing;
  }

  #assertWritable(ctx: Parameters<Parameters<RoomEventRepository["transact"]>[1]>[0]): Date {
    const now = this.#now();
    if (ctx.room.status !== "open" || (ctx.room.closes_at && new Date(ctx.room.closes_at).getTime() <= now.getTime())) {
      throw new RoomError("ROOM_NOT_OPEN");
    }
    return now;
  }

  async #assertMentionsAndReply(
    ctx: Parameters<Parameters<RoomEventRepository["transact"]>[1]>[0],
    mentions: readonly string[],
    replyTo: string | null,
  ): Promise<void> {
    if (!arrayOfStrings(mentions) || mentions.length > 5) throw new RoomError("INVALID_COMMAND");
    const allowed = await ctx.client.query<{ actor_id: string }>(
      `SELECT actor_id FROM room_member WHERE room_id = $1
       UNION ALL SELECT nova_actor_id AS actor_id FROM classroom_room WHERE room_id = $1`,
      [ctx.room.room_id],
    );
    const allowedIds = new Set(allowed.rows.map((row) => row.actor_id));
    if (mentions.some((id) => !allowedIds.has(id))) throw new RoomError("INVALID_COMMAND");
    if (replyTo === null) return;
    if (typeof replyTo !== "string" || !UUID.test(replyTo)) throw new RoomError("INVALID_COMMAND");
    const target = await this.#latestMessage(ctx, replyTo);
    if (!target || target.operation === "retract") throw new RoomError("INVALID_COMMAND");
  }

  async add(principal: AuthSession, command: RoomCommand, sessionId?: string): Promise<RoomEventEnvelope> {
    commandType(command, "message.add");
    if (principal.role !== "student" || principal.roomId !== command.roomId) throw new RoomError("FORBIDDEN");
    return this.ledger.transact(command.roomId, async (ctx) => {
      await this.#authorizeStudent(ctx, principal, sessionId);
      const existing = await ctx.findByCausation(command.commandId);
      const retry = this.#retry(existing, "message.added", principal.actorId);
      if (retry) return retry;
      const now = this.#assertWritable(ctx);
      const p = record(command.payload) ? command.payload : {};
      const text = typeof p.text === "string" ? p.text.trim() : "";
      const mediaIds = readUuidArray(p, "mediaIds", 4);
      const mentions = readUuidArray(p, "mentions", 5);
      if (!text && !mediaIds.length) throw new RoomError("INVALID_COMMAND");
      if (mediaIds.length > 4) throw new RoomError("INVALID_COMMAND");
      const replyTo = p.replyTo === undefined ? null : p.replyTo;
      await this.#assertMentionsAndReply(ctx, mentions, replyTo as string | null);
      await this.attachments.assertAttachable(ctx.client, principal, command.roomId, mediaIds);
      const messageId = randomUUID();
      const event = await ctx.append({ type: "message.added", actorId: principal.actorId, actorKind: "human", actorRole: "student", revision: 1, operation: "add", eventTime: new Date(command.clientTime), causationId: command.commandId, correlationId: randomUUID(), payload: { messageId, text, replyTo, mentions, mediaIds } });
      await this.attachments.bind?.(ctx.client, command.roomId, messageId, event.eventId, mediaIds);
      return event;
    });
  }

  async revise(principal: AuthSession, command: RoomCommand, sessionId?: string): Promise<RoomEventEnvelope> {
    commandType(command, "message.revise");
    return this.ledger.transact(command.roomId, async (ctx) => {
      if (principal.role === "student") await this.#authorizeStudent(ctx, principal, sessionId);
      else await this.#assertTeacherSession(ctx, principal, sessionId);
      const existing = this.#retry(await ctx.findByCausation(command.commandId), "message.revised", principal.actorId);
      if (existing) return existing;
      this.#assertWritable(ctx);
      if (!Number.isSafeInteger(command.baseRevision) || (command.baseRevision ?? 0) < 1) throw new RoomError("INVALID_COMMAND");
      const payload = record(command.payload) ? command.payload : {};
      const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
      const prior = await this.#latestMessage(ctx, messageId);
      if (!prior || prior.operation === "retract") throw new RoomError("MESSAGE_NOT_FOUND");
      if (principal.role !== "student" || prior.actor_id !== principal.actorId) throw new RoomError("FORBIDDEN");
      if (prior.revision !== command.baseRevision) throw new RoomError("REVISION_CONFLICT", prior.revision);
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      const replyTo = payload.replyTo === undefined ? null : payload.replyTo;
      const mentions = readUuidArray(payload, "mentions", 5);
      if (!text || mentions.length > 5) throw new RoomError("INVALID_COMMAND");
      await this.#assertMentionsAndReply(ctx, mentions, replyTo as string | null);
      const priorPayload = record(prior.payload) ? prior.payload : {};
      const mediaIds = arrayOfStrings(priorPayload.mediaIds) ? priorPayload.mediaIds : [];
      return ctx.append({ type: "message.revised", actorId: principal.actorId, actorKind: "human", actorRole: "student", revision: prior.revision + 1, operation: "revise", eventTime: new Date(command.clientTime), causationId: command.commandId, correlationId: randomUUID(), payload: { messageId, text, replyTo, mentions, mediaIds } });
    });
  }

  async retract(principal: AuthSession, command: RoomCommand, sessionId?: string): Promise<RoomEventEnvelope> {
    commandType(command, "message.retract");
    return this.ledger.transact(command.roomId, async (ctx) => {
      if (principal.role === "student") await this.#authorizeStudent(ctx, principal, sessionId);
      else await this.#assertTeacherSession(ctx, principal, sessionId);
      const existing = this.#retry(await ctx.findByCausation(command.commandId), "message.retracted", principal.actorId);
      if (existing) return existing;
      this.#assertWritable(ctx);
      if (!Number.isSafeInteger(command.baseRevision) || (command.baseRevision ?? 0) < 1) throw new RoomError("INVALID_COMMAND");
      const payload = record(command.payload) ? command.payload : {};
      const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
      const prior = await this.#latestMessage(ctx, messageId);
      if (!prior || prior.operation === "retract") throw new RoomError("MESSAGE_NOT_FOUND");
      if (principal.role === "student" && prior.actor_id !== principal.actorId) throw new RoomError("FORBIDDEN");
      if (prior.revision !== command.baseRevision) throw new RoomError("REVISION_CONFLICT", prior.revision);
      return ctx.append({ type: "message.retracted", actorId: principal.actorId, actorKind: "human", actorRole: principal.role === "teacher" ? "teacher" : "student", revision: prior.revision + 1, operation: "retract", eventTime: new Date(command.clientTime), causationId: command.commandId, correlationId: randomUUID(), payload: { messageId } });
    });
  }
}
