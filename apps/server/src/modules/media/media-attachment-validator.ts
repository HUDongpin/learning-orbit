import type { PoolClient } from "pg";

import type { AuthSession } from "@learning-orbit/contracts";
import { RoomError } from "../rooms/errors.js";
import type { AttachmentValidator } from "../rooms/attachment-validator.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTACHABLE = new Set(["uploaded", "processing", "ready"]);

function invalid(): never {
  throw new RoomError("INVALID_COMMAND");
}

export class MediaAttachmentValidator implements AttachmentValidator {
  async assertAttachable(
    tx: PoolClient,
    principal: AuthSession,
    roomId: string,
    mediaIds: readonly string[],
  ): Promise<void> {
    if (mediaIds.length === 0) return;
    if (principal.role !== "student" || principal.roomId !== roomId || !UUID.test(principal.actorId) || !UUID.test(roomId)) invalid();
    if (mediaIds.length > 4 || mediaIds.some((id) => !UUID.test(id)) || new Set(mediaIds).size !== mediaIds.length) invalid();
    const result = await tx.query<{ media_id: string; room_id: string; owner_actor_id: string; state: string }>(
      `SELECT media_id, room_id, owner_actor_id, state
       FROM media_asset WHERE media_id = ANY($1::uuid[]) FOR SHARE`,
      [mediaIds],
    );
    if (
      result.rows.length !== mediaIds.length
      || result.rows.some((row) => row.room_id !== roomId || row.owner_actor_id !== principal.actorId || !ATTACHABLE.has(row.state))
    ) invalid();
  }

  async bind(
    tx: PoolClient,
    roomId: string,
    messageId: string,
    sourceEventId: string,
    mediaIds: readonly string[],
  ): Promise<void> {
    if (mediaIds.length === 0) return;
    if (![roomId, messageId, sourceEventId].every((id) => UUID.test(id))) invalid();
    if (mediaIds.length > 4 || mediaIds.some((id) => !UUID.test(id)) || new Set(mediaIds).size !== mediaIds.length) invalid();
    await tx.query(
      `INSERT INTO media_attachment_binding(media_id, room_id, message_id, source_event_id)
       SELECT media_id, $1, $2, $3
       FROM unnest($4::uuid[]) AS media_id
       ON CONFLICT (media_id) DO NOTHING`,
      [roomId, messageId, sourceEventId, mediaIds],
    );
    const bound = await tx.query<{ media_id: string; room_id: string; message_id: string; source_event_id: string }>(
      `SELECT media_id, room_id, message_id, source_event_id
       FROM media_attachment_binding WHERE media_id = ANY($1::uuid[]) FOR SHARE`,
      [mediaIds],
    );
    if (
      bound.rows.length !== mediaIds.length
      || bound.rows.some((row) => row.room_id !== roomId || row.message_id !== messageId || row.source_event_id !== sourceEventId)
    ) invalid();
  }
}
