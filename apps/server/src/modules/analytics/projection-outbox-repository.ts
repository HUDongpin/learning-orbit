import type { Pool } from "pg";

export interface ProjectionPointer {
  projectionOutboxId: number;
  roomId: string;
  projectionKey: string;
  analysisEpoch: string;
  projectionVersion: number;
  completeThroughRoomSeq: number;
  snapshotUrl: string;
}

export class ProjectionOutboxRepository {
  constructor(private readonly pool: Pool) {}
  async claim(limit: number, workerId: string): Promise<ProjectionPointer[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_OUTBOX_LIMIT");
    const result = await this.pool.query(`
      WITH picked AS (
        SELECT projection_outbox_id FROM analysis_projection_outbox
        WHERE published_at IS NULL AND available_at <= now()
          AND (locked_at IS NULL OR locked_at < now() - interval '30 seconds')
        ORDER BY projection_outbox_id FOR UPDATE SKIP LOCKED LIMIT $1
      )
      UPDATE analysis_projection_outbox p
      SET locked_at=now(), locked_by=$2, publish_attempts=p.publish_attempts+1
      FROM picked WHERE p.projection_outbox_id=picked.projection_outbox_id
      RETURNING p.*`, [limit, workerId]);
    return result.rows.map((row: any) => ({
      projectionOutboxId: Number(row.projection_outbox_id), roomId: row.room_id,
      projectionKey: row.projection_key, analysisEpoch: row.analysis_epoch,
      projectionVersion: Number(row.projection_version),
      completeThroughRoomSeq: Number(row.complete_through_room_seq), snapshotUrl: row.snapshot_url,
    }));
  }
  async markPublished(id: number, workerId: string): Promise<void> {
    await this.pool.query(
      "UPDATE analysis_projection_outbox SET published_at=now(),locked_at=NULL,locked_by=NULL WHERE projection_outbox_id=$1 AND locked_by=$2",
      [id, workerId],
    );
  }
}
