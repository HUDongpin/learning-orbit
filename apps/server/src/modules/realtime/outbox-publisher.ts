import type { Pool } from "pg";
import { parseRoomEventEnvelope } from "@learning-orbit/contracts";
import type { RoomHub } from "./room-hub.js";
import { inTransaction } from "../../db/transactions.js";

export class OutboxPublisher {
  constructor(private readonly pool: Pool, private readonly hub: RoomHub, private readonly workerId = `realtime-${process.pid}`) {}
  async tick(limit = 100): Promise<number> {
    const rows = await inTransaction(this.pool, async tx => (await tx.query<any>(`WITH c AS (SELECT outbox_id FROM outbox_event WHERE published_at IS NULL AND available_at<=now() AND (locked_at IS NULL OR locked_at<now()-interval '2 minutes') ORDER BY available_at,created_at,outbox_id FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE outbox_event o SET locked_at=now(),locked_by=$2,publish_attempts=o.publish_attempts+1 FROM c WHERE o.outbox_id=c.outbox_id RETURNING o.outbox_id,o.room_id,o.envelope`, [limit, this.workerId])).rows);
    let published = 0;
    for (const row of rows) {
      try { const event = parseRoomEventEnvelope(row.envelope); if (event.roomId !== row.room_id) throw new Error("OUTBOX_ROOM_MISMATCH"); await this.hub.broadcastAuthorized(row.room_id, { type: "event", event }); await this.pool.query("UPDATE outbox_event SET published_at=now(),locked_at=NULL,locked_by=NULL,last_error=NULL WHERE outbox_id=$1 AND locked_by=$2", [row.outbox_id, this.workerId]); published += 1; }
      catch { await this.pool.query("UPDATE outbox_event SET available_at=now()+interval '5 seconds',locked_at=NULL,locked_by=NULL,last_error='PUBLISH_FAILED' WHERE outbox_id=$1 AND locked_by=$2", [row.outbox_id, this.workerId]); }
    }
    return published;
  }
}
