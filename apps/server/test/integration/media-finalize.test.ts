import { createHash, randomUUID } from "node:crypto";

import type { AuthSession } from "@learning-orbit/contracts";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";
import { MediaRepository } from "../../src/modules/media/media-repository.js";
import { MemoryMediaStore } from "../../src/modules/media/s3-media-store.js";
import { createUploadGrant, finalizeUpload, type MediaDeps } from "../../src/modules/media/media-service.js";
import { resetBusinessTables } from "../db/reset.js";
import { lifecycleDatabaseUrl, MutableClock } from "../rooms/lifecycle-test-fixture.js";

const pool = new Pool({ connectionString: lifecycleDatabaseUrl, max: 16 });
let roomId: string;
let teacherId: string;
let actorId: string;
let memberId: string;
let principal: AuthSession;
let clock: MutableClock;
let store: MemoryMediaStore;

async function seedRoom(): Promise<void> {
  teacherId = randomUUID(); roomId = randomUUID(); actorId = randomUUID(); memberId = randomUUID();
  const novaId = randomUUID();
  await pool.query("INSERT INTO teacher_account(teacher_id,email) VALUES($1,$2)", [teacherId, `finalize-${teacherId}@example.test`]);
  await pool.query(`INSERT INTO classroom_room(room_id,room_code_hash,nova_actor_id,teacher_id,topic) VALUES($1,decode($2,'hex'),$3,$4,'media')`, [roomId, randomUUID().replaceAll("-", ""), novaId, teacherId]);
  await pool.query(`INSERT INTO room_member(room_member_id,actor_id,room_id,seat_index,pseudonym,code_hash) VALUES($1,$2,$3,1,'探索者 A',decode($4,'hex'))`, [memberId, actorId, roomId, randomUUID().replaceAll("-", "")]);
  principal = { role: "student", actorId, roomId, roomMemberId: memberId, pseudonym: "探索者 A", nova: { actorId: novaId, actorKind: "agent", actorRole: "socratic_facilitator", displayName: "Nova Agent" } };
  const { RoomEventRepository } = await import("../../src/modules/rooms/room-event-repository.js");
  const { RoomLifecycleService } = await import("../../src/modules/rooms/lifecycle-service.js");
  const { createCoreEventPayloadRegistry } = await import("@learning-orbit/contracts");
  await new RoomLifecycleService(new RoomEventRepository(pool, createCoreEventPayloadRegistry(), clock), clock).open(roomId, teacherId, randomUUID());
}

function deps(): MediaDeps {
  return { pool, store, repo: new MediaRepository(pool, clock), clock, config: { storageBrowserOrigins: [store.browserOrigin] } };
}

async function issueAndPut(): Promise<{ mediaId: string; correlationId: string }> {
  const bytes = Buffer.from("synthetic-image");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const correlationId = randomUUID();
  const grant = await createUploadGrant(deps(), { principal, roomId, kind: "image", originalFileName: "pond.png", mime: "image/png", sizeBytes: bytes.length, sha256, altText: "池塘草圖", caption: "觀察", correlationId });
  const row = await pool.query<{ object_key: string }>("SELECT object_key FROM media_upload_grant WHERE media_id = $1", [grant.mediaId]);
  store.put(row.rows[0]!.object_key, bytes, "image/png");
  return { mediaId: grant.mediaId, correlationId };
}

beforeAll(async () => runMigrations(lifecycleDatabaseUrl, "infra/postgres/migrations"));
beforeEach(async () => { await resetBusinessTables(lifecycleDatabaseUrl); clock = new MutableClock(new Date().toISOString()); store = new MemoryMediaStore(); await seedRoom(); });
afterEach(async () => resetBusinessTables(lifecycleDatabaseUrl));
afterAll(async () => pool.end());

describe("media finalize", () => {
  it("promotes the exact staging object and enqueues one processing job", async () => {
    const input = await issueAndPut();
    const first = await finalizeUpload(deps(), { principal, roomId, mediaId: input.mediaId, correlationId: input.correlationId });
    expect(first).toMatchObject({ mediaId: input.mediaId, state: "uploaded", enqueued: true });
    const retry = await finalizeUpload(deps(), { principal, roomId, mediaId: input.mediaId, correlationId: input.correlationId });
    expect(retry).toMatchObject({ mediaId: input.mediaId, state: "uploaded", enqueued: false });
    const rows = await pool.query<{ jobs: number; state: string; object_key: string | null }>(
      `SELECT (SELECT count(*)::int FROM worker_job WHERE dedupe_key = $2) AS jobs,
              state, object_key FROM media_asset WHERE media_id = $1`,
      [input.mediaId, `media.process.v1:${input.mediaId}`],
    );
    expect(rows.rows[0]).toMatchObject({ jobs: 1, state: "uploaded", object_key: `rooms/${roomId}/original/${input.mediaId}` });
  });

  it("linearizes concurrent finalize calls to one immutable job", async () => {
    const input = await issueAndPut();
    const results = await Promise.all([
      finalizeUpload(deps(), { principal, roomId, mediaId: input.mediaId, correlationId: input.correlationId }),
      finalizeUpload(deps(), { principal, roomId, mediaId: input.mediaId, correlationId: input.correlationId }),
    ]);
    expect(results.map((result) => result.state)).toEqual(["uploaded", "uploaded"]);
    const jobs = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM worker_job WHERE job_type = 'media.process.v1'");
    expect(jobs.rows[0]?.count).toBe(1);
  });
});
