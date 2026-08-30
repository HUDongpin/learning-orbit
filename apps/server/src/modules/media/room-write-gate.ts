import type { PoolClient } from "pg";

import { systemClock, type Clock } from "../../clock.js";
import { MediaError } from "./media-errors.js";

export interface RoomWriteGate {
  assertWritable(client: PoolClient, roomId: string): Promise<void>;
}

/**
 * Plan 06 will replace this adapter with the durable deletion tombstone. For
 * the media pipeline it still performs a fail-closed room existence/status
 * check and gives tests an injectable gate for deletion races.
 */
export class DatabaseRoomWriteGate implements RoomWriteGate {
  constructor(private readonly clock: Clock = systemClock) {}

  async assertWritable(client: PoolClient, roomId: string): Promise<void> {
    const result = await client.query<{ status: string; closes_at: Date | null }>(
      "SELECT status, closes_at FROM classroom_room WHERE room_id = $1 FOR SHARE",
      [roomId],
    );
    const room = result.rows[0];
    const now = this.clock.now();
    const deadlinePassed = room?.closes_at instanceof Date
      && Number.isFinite(room.closes_at.getTime())
      && now instanceof Date
      && Number.isFinite(now.getTime())
      && room.closes_at.getTime() <= now.getTime();
    if (!room || !["open", "paused"].includes(room.status) || deadlinePassed) {
      throw new MediaError("ROOM_DELETION_IN_PROGRESS", 409);
    }
  }
}

export const allowRoomWrites: RoomWriteGate = {
  async assertWritable(_client: PoolClient, _roomId: string): Promise<void> {
    return undefined;
  },
};
