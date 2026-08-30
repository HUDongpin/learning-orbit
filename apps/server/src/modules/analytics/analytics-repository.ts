import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type ProjectionKey =
  | "echo.teacher_shadow" | "echo.student_approved"
  | "trace.teacher_bundle" | "trace.student_bundle";
export interface ProjectionRow {
  readonly schemaVersion: 1;
  readonly roomId: string;
  readonly projectionKey: ProjectionKey;
  readonly analysisEpoch: string;
  readonly version: number;
  readonly completeThroughRoomSeq: number;
  readonly watermarkEventTime: string;
  readonly algorithmVersion: string;
  readonly parameterHash: string;
  readonly requiresReplay: boolean;
  readonly evidenceStatus: "active" | "requires_replay";
  readonly reviewStatus: "unreviewed";
  readonly displayStatus: "teacher_shadow" | "student_approved" | "student_aggregate";
  readonly payload: unknown;
  readonly createdAt: string;
}
export interface PatchRow extends ProjectionRow {
  readonly baseVersion: number;
}
export interface PatchWindow {
  readonly kind: "patches" | "resync";
  readonly patches?: readonly PatchRow[];
  readonly snapshotUrl?: string;
}

function numberField(value: string | number, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`INVALID_ANALYTICS_ROW:${name}`);
  return result;
}
function mapProjection(row: any): ProjectionRow {
  const key = row.projection_key as ProjectionKey;
  return {
    schemaVersion: 1,
    roomId: row.room_id,
    projectionKey: key,
    analysisEpoch: row.analysis_epoch,
    version: numberField(row.version, "version"),
    completeThroughRoomSeq: numberField(row.complete_through_seq, "complete_through_seq"),
    watermarkEventTime: new Date(row.watermark_event_time).toISOString(),
    algorithmVersion: row.algorithm_version,
    parameterHash: row.parameter_hash,
    requiresReplay: Boolean(row.requires_replay),
    evidenceStatus: row.requires_replay ? "requires_replay" : "active",
    reviewStatus: "unreviewed",
    displayStatus: key === "echo.student_approved" ? "student_approved"
      : key === "trace.student_bundle" ? "student_aggregate" : "teacher_shadow",
    payload: row.payload,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
function mapPatch(row: any): PatchRow {
  return { ...mapProjection(row), baseVersion: numberField(row.base_version, "base_version") };
}
function contentHash(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]));
    }
    return item;
  };
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

export class AnalyticsRepository {
  constructor(private readonly pool: Pool) {}

  async latest(roomId: string, projectionKey: ProjectionKey): Promise<ProjectionRow | null> {
    const result = await this.pool.query(
      `SELECT s.room_id,s.projection_key,s.analysis_epoch,s.version,
              s.complete_through_seq,s.watermark_event_time,s.algorithm_version,
              s.parameter_hash,s.requires_replay,s.payload,s.created_at
       FROM analysis_projection_snapshots s
       JOIN analysis_room_heads h ON h.snapshot_id=s.snapshot_id
       WHERE h.room_id=$1 AND h.projection_key=$2
       LIMIT 1`,
      [roomId, projectionKey],
    );
    return result.rows[0] ? mapProjection(result.rows[0]) : null;
  }

  async patchesAfter(
    roomId: string,
    projectionKey: ProjectionKey,
    analysisEpoch: string,
    afterProjectionVersion: number,
    snapshotUrl: string,
  ): Promise<PatchWindow> {
    const headResult = await this.pool.query(
      `SELECT analysis_epoch,version,algorithm_version,parameter_hash
       FROM analysis_room_heads WHERE room_id=$1 AND projection_key=$2`,
      [roomId, projectionKey],
    );
    const head = headResult.rows[0];
    if (!head) return { kind: "resync", snapshotUrl };
    const headVersion = numberField(head.version, "version");
    if (head.analysis_epoch !== analysisEpoch || afterProjectionVersion > headVersion) {
      return { kind: "resync", snapshotUrl };
    }
    // TRACE bundles are atomic snapshots, never patch chains.
    if (projectionKey.startsWith("trace.") && afterProjectionVersion < headVersion) {
      return { kind: "resync", snapshotUrl };
    }
    const result = await this.pool.query(
      `SELECT room_id,projection_key,analysis_epoch,version,base_version,
              complete_through_seq,watermark_event_time,algorithm_version,
              parameter_hash,true AS requires_replay,payload,created_at
       FROM analysis_projection_patches
       WHERE room_id=$1 AND projection_key=$2 AND analysis_epoch=$3
         AND version>$4 AND version<=$5 ORDER BY version LIMIT 201`,
      [roomId, projectionKey, analysisEpoch, afterProjectionVersion, headVersion],
    );
    if (result.rows.length > 200) return { kind: "resync", snapshotUrl };
    const patches: PatchRow[] = [];
    let expected = afterProjectionVersion;
    for (const row of result.rows) {
      const patch = mapPatch(row);
      if (patch.baseVersion !== expected || patch.version !== expected + 1
        || patch.algorithmVersion !== head.algorithm_version
        || patch.parameterHash !== head.parameter_hash) {
        return { kind: "resync", snapshotUrl };
      }
      patches.push(patch);
      expected = patch.version;
    }
    if (expected !== headVersion) return { kind: "resync", snapshotUrl };
    return { kind: "patches", patches };
  }

  async timeline(
    roomId: string,
    projectionKey: "echo.teacher_shadow" | "echo.student_approved",
    analysisEpoch: string,
    limit: number,
  ): Promise<{ baseSnapshot: ProjectionRow | null; patches: readonly PatchRow[]; truncatedBeforeVersion: number | null; headVersion: number }> {
    const headResult = await this.pool.query(
      "SELECT version FROM analysis_room_heads WHERE room_id=$1 AND projection_key=$2 AND analysis_epoch=$3",
      [roomId, projectionKey, analysisEpoch],
    );
    const headVersion = headResult.rows[0] ? numberField(headResult.rows[0].version, "version") : 0;
    const result = await this.pool.query(
      `SELECT room_id,projection_key,analysis_epoch,version,base_version,
              complete_through_seq,watermark_event_time,algorithm_version,
              parameter_hash,true AS requires_replay,payload,created_at
       FROM analysis_projection_patches
       WHERE room_id=$1 AND projection_key=$2 AND analysis_epoch=$3
       ORDER BY version DESC LIMIT $4`, [roomId, projectionKey, analysisEpoch, limit],
    );
    const patches = result.rows.map(mapPatch).sort((a, b) => a.version - b.version);
    const first = patches[0]?.version ?? headVersion;
    const base = first > 1 ? await this.pool.query(
      `SELECT room_id,projection_key,analysis_epoch,version,complete_through_seq,
              watermark_event_time,algorithm_version,parameter_hash,requires_replay,payload,created_at
       FROM analysis_projection_snapshots
       WHERE room_id=$1 AND projection_key=$2 AND analysis_epoch=$3 AND version=$4`,
      [roomId, projectionKey, analysisEpoch, first - 1],
    ) : { rows: [] };
    return {
      baseSnapshot: base.rows[0] ? mapProjection(base.rows[0]) : null,
      patches,
      truncatedBeforeVersion: first > 1 ? first : null,
      headVersion,
    };
  }

  /** Used by worker adapters/tests to keep projection pointers separate. */
  static async persistProjection(
    client: PoolClient,
    input: { snapshot: ProjectionRow; patch?: PatchRow; snapshotUrl: string },
  ): Promise<void> {
    const { snapshot, patch, snapshotUrl } = input;
    await client.query(
      `INSERT INTO analysis_projection_snapshots(
         snapshot_id,room_id,algorithm,projection_key,analysis_epoch,version,
         complete_through_seq,watermark_event_time,requires_replay,schema_version,
         algorithm_version,parameter_hash,payload,content_sha256)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12)
       ON CONFLICT (room_id,projection_key,analysis_epoch,version) DO NOTHING`,
      [snapshot.roomId, snapshot.projectionKey.startsWith("echo.") ? "ECHO-CM" : "TRACE-AI",
        snapshot.projectionKey, snapshot.analysisEpoch, snapshot.version,
        snapshot.completeThroughRoomSeq, snapshot.watermarkEventTime, snapshot.requiresReplay,
        snapshot.algorithmVersion, snapshot.parameterHash, snapshot.payload,
        contentHash(snapshot.payload)],
    );
    if (patch) {
      await client.query(
        `INSERT INTO analysis_projection_patches(
           patch_id,room_id,projection_key,analysis_epoch,base_version,version,
           complete_through_seq,algorithm_version,parameter_hash,payload,content_sha256)
         VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (room_id,projection_key,analysis_epoch,version) DO NOTHING`,
        [patch.roomId, patch.projectionKey, patch.analysisEpoch, patch.baseVersion, patch.version,
          patch.completeThroughRoomSeq, patch.algorithmVersion, patch.parameterHash, patch.payload,
          contentHash(patch.payload)],
      );
    }
    await client.query(
      `INSERT INTO analysis_projection_outbox(
         room_id,projection_key,analysis_epoch,projection_version,
         complete_through_room_seq,snapshot_url)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (room_id,projection_key,analysis_epoch,projection_version) DO NOTHING`,
      [snapshot.roomId, snapshot.projectionKey, snapshot.analysisEpoch, snapshot.version,
        snapshot.completeThroughRoomSeq, snapshotUrl],
    );
  }
}
