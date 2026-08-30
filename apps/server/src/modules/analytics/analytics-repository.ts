import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { analyticsContract } from "@learning-orbit/contracts";

export type ProjectionKey =
  | "echo.teacher_shadow" | "echo.student_approved"
  | "trace.teacher_bundle" | "trace.student_bundle";
export interface ProjectionRow {
  readonly schemaVersion: 1;
  readonly roomId: string;
  readonly projectionKey: ProjectionKey;
  readonly analysisEpoch: string;
  readonly version: number;
  readonly baseVersion: number;
  readonly completeThroughRoomSeq: number;
  readonly watermarkEventTime: string;
  readonly algorithmVersion: string;
  readonly parameterHash: string;
  readonly requiresReplay: boolean;
  readonly evidenceStatus: "active" | "requires_replay";
  readonly reviewStatus: "unreviewed" | "approved" | "rejected" | "corrected";
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

/** Convert the internal SQL `version` alias to the public contract field. */
export function projectionWire(row: ProjectionRow): Record<string, unknown> {
  return {
    schemaVersion: row.schemaVersion,
    projectionKey: row.projectionKey,
    roomId: row.roomId,
    analysisEpoch: row.analysisEpoch,
    algorithmVersion: row.algorithmVersion,
    parameterHash: row.parameterHash,
    projectionVersion: row.version,
    baseVersion: row.baseVersion,
    completeThroughRoomSeq: row.completeThroughRoomSeq,
    watermarkEventTime: row.watermarkEventTime,
    requiresReplay: row.requiresReplay,
    evidenceStatus: row.evidenceStatus,
    reviewStatus: row.reviewStatus,
    displayStatus: row.displayStatus,
    warnings: [],
    payload: row.payload,
  };
}

export function patchWire(row: PatchRow): Record<string, unknown> {
  const payload = row.payload && typeof row.payload === "object"
    ? row.payload as Record<string, unknown> : {};
  return {
    analysisEpoch: row.analysisEpoch,
    algorithmVersion: row.algorithmVersion,
    parameterHash: row.parameterHash,
    projectionVersion: row.version,
    baseVersion: row.baseVersion,
    completeThroughRoomSeq: row.completeThroughRoomSeq,
    requiresReplay: row.requiresReplay,
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    nodesAdded: Array.isArray(payload.nodesAdded) ? payload.nodesAdded : [],
    nodesUpdated: Array.isArray(payload.nodesUpdated) ? payload.nodesUpdated : [],
    nodesHidden: Array.isArray(payload.nodesHidden) ? payload.nodesHidden : [],
    edgesAdded: Array.isArray(payload.edgesAdded) ? payload.edgesAdded : [],
    edgesUpdated: Array.isArray(payload.edgesUpdated) ? payload.edgesUpdated : [],
    edgesHidden: Array.isArray(payload.edgesHidden) ? payload.edgesHidden : [],
    positionUpdates: Array.isArray(payload.positionUpdates) ? payload.positionUpdates : [],
    changeScore: typeof payload.changeScore === "number" ? payload.changeScore : 0,
    reasonCodes: Array.isArray(payload.reasonCodes) ? payload.reasonCodes : [],
    evidenceRefs: Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : [],
  };
}

export class AnalyticsRepositoryError extends Error {
  readonly code = "ANALYTICS_CORRUPT" as const;
  constructor() { super("ANALYTICS_CORRUPT"); }
}

function numberField(value: unknown, _name: string): number {
  if (typeof value === "boolean") throw new AnalyticsRepositoryError();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new AnalyticsRepositoryError();
  return result;
}

function validateProjectionWire(candidate: Record<string, unknown>, key: ProjectionKey): void {
  try {
    if (key.startsWith("echo.")) analyticsContract.parseEchoSnapshot(candidate);
    else analyticsContract.parseTrace(candidate);
  } catch {
    throw new AnalyticsRepositoryError();
  }
}

function validatePatchWire(candidate: Record<string, unknown>, key: ProjectionKey): void {
  if (typeof key !== "string" || !key.startsWith("echo.")) throw new AnalyticsRepositoryError();
  try { analyticsContract.parseEchoPatch(candidate); }
  catch { throw new AnalyticsRepositoryError(); }
}

function mapProjection(row: any): ProjectionRow {
  const key = row.projection_key as ProjectionKey;
  if (!TEACHER_PROJECTION_KEYS.has(key)) throw new AnalyticsRepositoryError();
  if (typeof row.requires_replay !== "boolean") throw new AnalyticsRepositoryError();
  if (row.schema_version !== undefined && row.schema_version !== 1) throw new AnalyticsRepositoryError();
  if (row.algorithm !== undefined) {
    const expectedAlgorithm = key.startsWith("echo.") ? "ECHO-CM" : "TRACE-AI";
    if (row.algorithm !== expectedAlgorithm) throw new AnalyticsRepositoryError();
  }
  const watermark = new Date(row.watermark_event_time);
  const created = new Date(row.created_at);
  if (!Number.isFinite(watermark.getTime()) || !Number.isFinite(created.getTime())) {
    throw new AnalyticsRepositoryError();
  }
  const version = numberField(row.version, "version");
  const baseVersion = row.base_version === undefined || row.base_version === null
    ? Math.max(0, version - 1) : numberField(row.base_version, "base_version");
  if (baseVersion !== version - 1) throw new AnalyticsRepositoryError();
  const completeThroughRoomSeq = numberField(row.complete_through_seq, "complete_through_seq");
  const requiresReplay = row.requires_replay;
  const reviewStatus = key === "trace.student_bundle" ? "approved" as const : "unreviewed" as const;
  const displayStatus = key === "echo.student_approved" ? "student_approved"
    : key === "trace.student_bundle" ? "student_aggregate" : "teacher_shadow";
  // Wire contracts use projectionVersion/baseVersion and do not expose the
  // repository's compact `version` alias.  Validate before returning any
  // database JSON to a browser; malformed or cross-view payloads fail closed.
  validateProjectionWire({
    schemaVersion: 1,
    roomId: row.room_id,
    projectionKey: key,
    analysisEpoch: row.analysis_epoch,
    algorithmVersion: row.algorithm_version,
    parameterHash: row.parameter_hash,
    projectionVersion: version,
    baseVersion,
    completeThroughRoomSeq,
    watermarkEventTime: watermark.toISOString(),
    requiresReplay,
    evidenceStatus: row.requires_replay ? "requires_replay" : "active",
    reviewStatus,
    displayStatus,
    warnings: [],
    payload: row.payload,
  }, key);
  const result: ProjectionRow = {
    schemaVersion: 1,
    roomId: String(row.room_id),
    projectionKey: key,
    analysisEpoch: String(row.analysis_epoch),
    version,
    baseVersion,
    completeThroughRoomSeq,
    watermarkEventTime: watermark.toISOString(),
    algorithmVersion: String(row.algorithm_version),
    parameterHash: String(row.parameter_hash),
    requiresReplay,
    evidenceStatus: requiresReplay ? "requires_replay" : "active",
    reviewStatus,
    displayStatus,
    payload: row.payload,
    createdAt: created.toISOString(),
  };
  return result;
}
function mapPatch(row: any): PatchRow {
  const watermark = new Date(row.watermark_event_time);
  const created = new Date(row.created_at);
  if (!Number.isFinite(watermark.getTime()) || !Number.isFinite(created.getTime())) {
    throw new AnalyticsRepositoryError();
  }
  const baseVersion = numberField(row.base_version, "base_version");
  const version = numberField(row.version, "version");
  if (baseVersion !== version - 1) throw new AnalyticsRepositoryError();
  const key = row.projection_key as ProjectionKey;
  if (row.schema_version !== undefined && row.schema_version !== 1) throw new AnalyticsRepositoryError();
  if (row.algorithm !== undefined && row.algorithm !== "ECHO-CM") throw new AnalyticsRepositoryError();
  const rawPayload = row.payload;
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    throw new AnalyticsRepositoryError();
  }
  const payload = rawPayload as Record<string, unknown>;
  if (typeof payload.requiresReplay !== "boolean") {
    throw new AnalyticsRepositoryError();
  }
  if (typeof row.requires_replay !== "boolean") throw new AnalyticsRepositoryError();
  const requiresReplay = payload.requiresReplay;
  if (payload.requiresReplay !== row.requires_replay) {
    throw new AnalyticsRepositoryError();
  }
  validatePatchWire({
    analysisEpoch: row.analysis_epoch,
    algorithmVersion: row.algorithm_version,
    parameterHash: row.parameter_hash,
    projectionVersion: version,
    baseVersion,
    completeThroughRoomSeq: numberField(row.complete_through_seq, "complete_through_seq"),
    requiresReplay,
    warnings: [],
    nodesAdded: row.payload?.nodesAdded ?? [],
    nodesUpdated: row.payload?.nodesUpdated ?? [],
    nodesHidden: row.payload?.nodesHidden ?? [],
    edgesAdded: row.payload?.edgesAdded ?? [],
    edgesUpdated: row.payload?.edgesUpdated ?? [],
    edgesHidden: row.payload?.edgesHidden ?? [],
    positionUpdates: row.payload?.positionUpdates ?? [],
    changeScore: row.payload?.changeScore ?? 0,
    reasonCodes: row.payload?.reasonCodes ?? [],
    evidenceRefs: row.payload?.evidenceRefs ?? [],
  }, key);
  if (!TEACHER_PROJECTION_KEYS.has(key)) throw new AnalyticsRepositoryError();
  return {
    schemaVersion: 1,
    roomId: row.room_id,
    projectionKey: key,
    analysisEpoch: row.analysis_epoch,
    version,
    baseVersion,
    completeThroughRoomSeq: numberField(row.complete_through_seq, "complete_through_seq"),
    watermarkEventTime: watermark.toISOString(),
    algorithmVersion: row.algorithm_version,
    parameterHash: row.parameter_hash,
    requiresReplay,
    evidenceStatus: requiresReplay ? "requires_replay" : "active",
    reviewStatus: "unreviewed",
    displayStatus: key === "echo.student_approved" ? "student_approved"
      : key === "trace.student_bundle" ? "student_aggregate" : "teacher_shadow",
    payload: row.payload,
    createdAt: created.toISOString(),
  };
}

function validatePatchChain(
  rows: readonly any[],
  afterVersion: number,
  head: { version: number; analysisEpoch: string; algorithmVersion: string; parameterHash: string; roomId: string; projectionKey: ProjectionKey },
): PatchRow[] | null {
  const patches: PatchRow[] = [];
  let expected = afterVersion;
  try {
    for (const row of rows) {
      const patch = mapPatch(row);
      if (patch.roomId !== head.roomId
        || patch.projectionKey !== head.projectionKey
        || patch.analysisEpoch !== head.analysisEpoch
        || patch.algorithmVersion !== head.algorithmVersion
        || patch.parameterHash !== head.parameterHash
        || patch.baseVersion !== expected
        || patch.version !== expected + 1) return null;
      patches.push(patch);
      expected = patch.version;
    }
  } catch (error) {
    if (error instanceof AnalyticsRepositoryError) return null;
    throw error;
  }
  return expected === head.version ? patches : null;
}

const TEACHER_PROJECTION_KEYS = new Set<ProjectionKey>([
  "echo.teacher_shadow", "echo.student_approved", "trace.teacher_bundle", "trace.student_bundle",
]);
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
              GREATEST(0,s.version-1) AS base_version,
              s.complete_through_seq,s.watermark_event_time,s.algorithm_version,
              s.parameter_hash,s.requires_replay,s.algorithm,s.schema_version,s.payload,s.created_at
       FROM analysis_projection_snapshots s
       JOIN analysis_room_heads h ON h.snapshot_id=s.snapshot_id
       WHERE h.room_id=$1 AND h.projection_key=$2
         AND s.room_id=h.room_id AND s.projection_key=h.projection_key
         AND h.analysis_epoch=s.analysis_epoch AND h.version=s.version
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
    if (!Number.isSafeInteger(afterProjectionVersion) || afterProjectionVersion < 0) {
      throw new AnalyticsRepositoryError();
    }
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
      `SELECT p.room_id,p.projection_key,p.analysis_epoch,p.version,p.base_version,
              p.complete_through_seq,s.watermark_event_time,p.algorithm_version,
              p.parameter_hash,s.requires_replay,s.algorithm,s.schema_version,
              p.payload,p.created_at
       FROM analysis_projection_patches p
       JOIN analysis_projection_snapshots s
         ON s.room_id=p.room_id AND s.projection_key=p.projection_key
        AND s.analysis_epoch=p.analysis_epoch AND s.version=p.version
       WHERE p.room_id=$1 AND p.projection_key=$2 AND p.analysis_epoch=$3
         AND p.version>$4 AND p.version<=$5 ORDER BY p.version LIMIT 201`,
      [roomId, projectionKey, analysisEpoch, afterProjectionVersion, headVersion],
    );
    if (result.rows.length > 200) return { kind: "resync", snapshotUrl };
    const patches = validatePatchChain(result.rows, afterProjectionVersion, {
      version: headVersion, analysisEpoch: head.analysis_epoch,
      algorithmVersion: head.algorithm_version, parameterHash: head.parameter_hash,
      roomId, projectionKey,
    });
    if (patches === null) return { kind: "resync", snapshotUrl };
    return { kind: "patches", patches };
  }

  async timeline(
    roomId: string,
    projectionKey: "echo.teacher_shadow" | "echo.student_approved",
    analysisEpoch: string,
    limit: number,
  ): Promise<{ kind: "timeline" | "resync"; baseSnapshot: ProjectionRow | null; patches: readonly PatchRow[]; truncatedBeforeVersion: number | null; headVersion: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new AnalyticsRepositoryError();
    const headResult = await this.pool.query(
      "SELECT version,analysis_epoch,algorithm_version,parameter_hash FROM analysis_room_heads WHERE room_id=$1 AND projection_key=$2 AND analysis_epoch=$3",
      [roomId, projectionKey, analysisEpoch],
    );
    const head = headResult.rows[0];
    const headVersion = head ? numberField(head.version, "version") : 0;
    if (!head) return { kind: "resync", baseSnapshot: null, patches: [], truncatedBeforeVersion: null, headVersion: 0 };
    const expectedCount = Math.min(limit, headVersion);
    const result = await this.pool.query(
      `SELECT p.room_id,p.projection_key,p.analysis_epoch,p.version,p.base_version,
              p.complete_through_seq,s.watermark_event_time,p.algorithm_version,
              p.parameter_hash,s.requires_replay,s.algorithm,s.schema_version,
              p.payload,p.created_at
       FROM analysis_projection_patches p
       JOIN analysis_projection_snapshots s
         ON s.room_id=p.room_id AND s.projection_key=p.projection_key
        AND s.analysis_epoch=p.analysis_epoch AND s.version=p.version
       WHERE p.room_id=$1 AND p.projection_key=$2 AND p.analysis_epoch=$3
       ORDER BY p.version DESC LIMIT $4`, [roomId, projectionKey, analysisEpoch, limit],
    );
    if (result.rows.length !== expectedCount) {
      return { kind: "resync", baseSnapshot: null, patches: [], truncatedBeforeVersion: null, headVersion };
    }
    const patches = validatePatchChain([...result.rows].reverse(), headVersion - expectedCount, {
      version: headVersion, analysisEpoch: head.analysis_epoch,
      algorithmVersion: head.algorithm_version, parameterHash: head.parameter_hash,
      roomId, projectionKey,
    });
    if (patches === null) return { kind: "resync", baseSnapshot: null, patches: [], truncatedBeforeVersion: null, headVersion };
    const first = patches[0]?.version ?? headVersion;
    if (headVersion > 0 && patches.length === 0) return { kind: "resync", baseSnapshot: null, patches: [], truncatedBeforeVersion: null, headVersion };
    const base = first > 1 ? await this.pool.query(
      `SELECT room_id,projection_key,analysis_epoch,version,GREATEST(0,version-1) AS base_version,complete_through_seq,
              watermark_event_time,algorithm_version,parameter_hash,requires_replay,algorithm,schema_version,payload,created_at
       FROM analysis_projection_snapshots
       WHERE room_id=$1 AND projection_key=$2 AND analysis_epoch=$3 AND version=$4`,
      [roomId, projectionKey, analysisEpoch, first - 1],
    ) : { rows: [] };
    if (first > 1 && !base.rows[0]) {
      return { kind: "resync", baseSnapshot: null, patches: [], truncatedBeforeVersion: null, headVersion };
    }
    return {
      baseSnapshot: base.rows[0] ? mapProjection(base.rows[0]) : null,
      patches,
      // The suffix begins at `first`; report the first version omitted from
      // the returned window (not the first version included).
      truncatedBeforeVersion: first > 1 ? first - 1 : null,
      headVersion,
      kind: "timeline",
    };
  }

  /** Used by worker adapters/tests to keep projection pointers separate. */
  static async persistProjection(
    client: PoolClient,
    input: { snapshot: ProjectionRow; patch?: PatchRow; snapshotUrl: string },
  ): Promise<void> {
    const { snapshot, patch, snapshotUrl } = input;
    if (!TEACHER_PROJECTION_KEYS.has(snapshot.projectionKey)
      || !Number.isSafeInteger(snapshot.version) || snapshot.version < 1
      || !Number.isSafeInteger(snapshot.baseVersion) || snapshot.baseVersion !== snapshot.version - 1
      || !/^[a-f0-9]{64}$/.test(snapshot.parameterHash)) {
      throw new AnalyticsRepositoryError();
    }
    const wire = projectionWire(snapshot);
    try {
      if (snapshot.projectionKey.startsWith("echo.")) analyticsContract.parseEchoSnapshot(wire);
      else analyticsContract.parseTrace(wire);
    } catch { throw new AnalyticsRepositoryError(); }
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
      if (patch.roomId !== snapshot.roomId || patch.projectionKey !== snapshot.projectionKey
        || patch.analysisEpoch !== snapshot.analysisEpoch || patch.baseVersion !== snapshot.baseVersion
        || patch.version !== snapshot.version) throw new AnalyticsRepositoryError();
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
    const head = await client.query<{ version: string }>(
      "SELECT version FROM analysis_room_heads WHERE room_id=$1 AND projection_key=$2 FOR UPDATE",
      [snapshot.roomId, snapshot.projectionKey],
    );
    const currentVersion = head.rows[0] ? numberField(head.rows[0].version, "version") : 0;
    if (currentVersion + 1 !== snapshot.version) {
      if (currentVersion >= snapshot.version) return;
      throw new AnalyticsRepositoryError();
    }
    await client.query(
      `INSERT INTO analysis_room_heads(
         room_id,projection_key,analysis_epoch,version,complete_through_seq,
         algorithm_version,parameter_hash,max_seen_event_time,watermark_event_time,
         requires_replay,snapshot_id)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$8,$9,
              snapshot_id
       FROM analysis_projection_snapshots
       WHERE room_id=$1 AND projection_key=$2 AND analysis_epoch=$3 AND version=$4
       ON CONFLICT (room_id,projection_key) DO UPDATE SET
         analysis_epoch=EXCLUDED.analysis_epoch,version=EXCLUDED.version,
         complete_through_seq=EXCLUDED.complete_through_seq,
         algorithm_version=EXCLUDED.algorithm_version,parameter_hash=EXCLUDED.parameter_hash,
         max_seen_event_time=EXCLUDED.max_seen_event_time,
         watermark_event_time=EXCLUDED.watermark_event_time,
         requires_replay=EXCLUDED.requires_replay,snapshot_id=EXCLUDED.snapshot_id,
         updated_at=now()`,
      [snapshot.roomId, snapshot.projectionKey, snapshot.analysisEpoch, snapshot.version,
        snapshot.completeThroughRoomSeq, snapshot.algorithmVersion, snapshot.parameterHash,
        snapshot.watermarkEventTime, snapshot.requiresReplay],
    );
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
