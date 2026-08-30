import type { Pool } from "pg";
import { routes } from "@learning-orbit/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECTIONS = new Set([
  "echo.teacher_shadow", "echo.student_approved",
  "trace.teacher_bundle", "trace.student_bundle",
]);

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
    if (typeof workerId !== "string" || workerId.length < 1 || workerId.length > 128) throw new Error("INVALID_OUTBOX_WORKER");
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
    return result.rows.map((row: any) => {
      const id = Number(row.projection_outbox_id);
      const projectionVersion = Number(row.projection_version);
      const completeThrough = Number(row.complete_through_room_seq);
      if (!Number.isSafeInteger(id) || id < 1
        || typeof row.room_id !== "string" || !UUID.test(row.room_id)
        || typeof row.projection_key !== "string" || !PROJECTIONS.has(row.projection_key)
        || typeof row.analysis_epoch !== "string" || !UUID.test(row.analysis_epoch)
        || !Number.isSafeInteger(projectionVersion) || projectionVersion < 1
        || !Number.isSafeInteger(completeThrough) || completeThrough < 0
        || typeof row.snapshot_url !== "string"
        || row.snapshot_url !== routes.analytics.latest(row.room_id, row.projection_key)) {
        throw new Error("ANALYTICS_OUTBOX_CORRUPT");
      }
      return {
        projectionOutboxId: id, roomId: row.room_id,
        projectionKey: row.projection_key, analysisEpoch: row.analysis_epoch,
        projectionVersion, completeThroughRoomSeq: completeThrough,
        snapshotUrl: row.snapshot_url,
      };
    });
  }
  async markPublished(id: number, workerId: string): Promise<void> {
    const result = await this.pool.query(
      "UPDATE analysis_projection_outbox SET published_at=now(),locked_at=NULL,locked_by=NULL WHERE projection_outbox_id=$1 AND locked_by=$2",
      [id, workerId],
    );
    if (result.rowCount !== 1) throw new Error("ANALYTICS_OUTBOX_CLAIM_STALE");
  }
  async release(id: number, workerId: string, errorCode = "PROJECTION_PUBLISH_FAILED"): Promise<void> {
    if (!/^[A-Z0-9_]{1,64}$/.test(errorCode)) throw new Error("ANALYTICS_OUTBOX_ERROR_INVALID");
    await this.pool.query(
      `UPDATE analysis_projection_outbox
          SET available_at=now()+interval '5 seconds',locked_at=NULL,locked_by=NULL,last_error=$3
        WHERE projection_outbox_id=$1 AND locked_by=$2`,
      [id, workerId, errorCode],
    );
  }
}
