import type { Pool } from "pg";
import { parseRoomEventEnvelope, realtimeContract, type ProjectionFrame } from "@learning-orbit/contracts";
import type { ProjectionOutboxRepository } from "../analytics/projection-outbox-repository.js";
import type { ProjectionDeliveryAuthorizer, RoomHub } from "./room-hub.js";
import { inTransaction } from "../../db/transactions.js";
import { createTelemetry, type Telemetry } from "../../observability/telemetry.js";

export interface ProjectionPublisherDeps {
  readonly repository: ProjectionOutboxRepository;
  readonly authorize: ProjectionDeliveryAuthorizer;
}

export class OutboxPublisher {
  constructor(
    private readonly pool: Pool,
    private readonly hub: RoomHub,
    private readonly workerId = `realtime-${process.pid}`,
    private readonly projection?: ProjectionPublisherDeps,
    private readonly telemetry: Telemetry = createTelemetry(),
    /** Present only when fault controls were enabled at startup. */
    private readonly faults?: { readonly outboxPaused: boolean },
  ) {}
  async tick(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_OUTBOX_LIMIT");
    // A paused outbox claims nothing, so the rows stay unlocked and a resumed
    // publisher finds exactly the backlog a crashed one would have left.
    if (this.faults?.outboxPaused) return 0;
    const rows = await inTransaction(this.pool, async tx => (await tx.query<any>(`WITH c AS (SELECT outbox_id FROM outbox_event WHERE published_at IS NULL AND available_at<=now() AND (locked_at IS NULL OR locked_at<now()-interval '2 minutes') ORDER BY available_at,created_at,outbox_id FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE outbox_event o SET locked_at=now(),locked_by=$2,publish_attempts=o.publish_attempts+1 FROM c WHERE o.outbox_id=c.outbox_id RETURNING o.outbox_id,o.room_id,o.envelope`, [limit, this.workerId])).rows);
    let published = 0;
    for (const row of rows) {
      const span = this.telemetry.startSpan("outbox.publish", { roomId: row.room_id });
      try { const event = parseRoomEventEnvelope(row.envelope); if (event.roomId !== row.room_id) throw new Error("OUTBOX_ROOM_MISMATCH"); const sent = await this.hub.broadcastAuthorized(row.room_id, { type: "event", event }); await this.pool.query("UPDATE outbox_event SET published_at=now(),locked_at=NULL,locked_by=NULL,last_error=NULL WHERE outbox_id=$1 AND locked_by=$2", [row.outbox_id, this.workerId]); published += 1; const trace = { correlationId: event.correlationId, eventId: event.eventId, roomSeq: event.roomSeq }; span.end(undefined, trace); this.telemetry.record("websocket.send", { roomId: row.room_id, ...trace, recipients: sent }); }
      catch { span.end(undefined, { failureCode: "PUBLISH_FAILED" }); await this.pool.query("UPDATE outbox_event SET available_at=now()+interval '5 seconds',locked_at=NULL,locked_by=NULL,last_error='PUBLISH_FAILED' WHERE outbox_id=$1 AND locked_by=$2", [row.outbox_id, this.workerId]); }
    }
    if (this.projection) {
      const pointers = await this.projection.repository.claim(Math.min(limit, 100), this.workerId);
      for (const pointer of pointers) {
        try {
          const frame: ProjectionFrame = {
            type: "projection",
            roomId: pointer.roomId,
            projectionKey: pointer.projectionKey as ProjectionFrame["projectionKey"],
            analysisEpoch: pointer.analysisEpoch,
            projectionVersion: pointer.projectionVersion,
            completeThroughRoomSeq: pointer.completeThroughRoomSeq,
            snapshotUrl: pointer.snapshotUrl,
          };
          const validated = realtimeContract.parseRealtimeFrame(frame);
          if (validated.type !== "projection") throw new Error("ANALYTICS_FRAME_INVALID");
          const sent = await this.hub.broadcastProjectionAuthorized(pointer.roomId, validated, this.projection.authorize);
          await this.projection.repository.markPublished(pointer.projectionOutboxId, this.workerId);
          published += 1;
          this.telemetry.record("projection.commit", {
            roomId: pointer.roomId,
            projectionVersion: pointer.projectionVersion,
            completeThroughRoomSeq: pointer.completeThroughRoomSeq,
            recipients: sent,
          });
        } catch {
          await this.projection.repository.release(pointer.projectionOutboxId, this.workerId);
        }
      }
    }
    return published;
  }
}
