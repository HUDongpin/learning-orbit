import { randomUUID } from "node:crypto";

import type { AuthSession } from "@learning-orbit/contracts";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";
import { MediaRepository } from "../../src/modules/media/media-repository.js";
import { MemoryMediaStore } from "../../src/modules/media/s3-media-store.js";
import { createUploadGrant, type MediaDeps } from "../../src/modules/media/media-service.js";
import { resetBusinessTables } from "../db/reset.js";
import { lifecycleDatabaseUrl, MutableClock } from "../rooms/lifecycle-test-fixture.js";

const pool = new Pool({ connectionString: lifecycleDatabaseUrl, max: 8 });
let roomId: string;
let teacherId: string;
let actorId: string;
let memberId: string;
let clock: MutableClock;
let principal: AuthSession;

async function seedOpenRoom(): Promise<void> {
  teacherId = randomUUID();
  roomId = randomUUID();
  actorId = randomUUID();
  memberId = randomUUID();
  const novaId = randomUUID();
  await pool.query("INSERT INTO teacher_account(teacher_id,email) VALUES($1,$2)", [teacherId, `upload-${teacherId}@example.test`]);
  await pool.query(
    `INSERT INTO classroom_room(room_id,room_code_hash,nova_actor_id,teacher_id,topic)
     VALUES($1,decode($2,'hex'),$3,$4,'media')`,
    [roomId, randomUUID().replaceAll("-", ""), novaId, teacherId],
  );
  await pool.query(
    `INSERT INTO room_member(room_member_id,actor_id,room_id,seat_index,pseudonym,code_hash)
     VALUES($1,$2,$3,1,'探索者 A',decode($4,'hex'))`,
    [memberId, actorId, roomId, randomUUID().replaceAll("-", "")],
  );
  principal = {
    role: "student",
    actorId,
    roomId,
    roomMemberId: memberId,
    pseudonym: "探索者 A",
    nova: { actorId: novaId, actorKind: "agent", actorRole: "socratic_facilitator", displayName: "Nova Agent" },
  };
  const { RoomEventRepository } = await import("../../src/modules/rooms/room-event-repository.js");
  const { RoomLifecycleService } = await import("../../src/modules/rooms/lifecycle-service.js");
  await new RoomLifecycleService(new RoomEventRepository(pool, (await import("@learning-orbit/contracts")).createCoreEventPayloadRegistry(), clock), clock).open(roomId, teacherId, randomUUID());
}

function deps(store = new MemoryMediaStore()): MediaDeps {
  return {
    pool,
    store,
    repo: new MediaRepository(pool, clock),
    clock,
    config: { storageBrowserOrigins: [store.browserOrigin] },
  };
}

beforeAll(async () => runMigrations(lifecycleDatabaseUrl, "infra/postgres/migrations"));
beforeEach(async () => {
  await resetBusinessTables(lifecycleDatabaseUrl);
  clock = new MutableClock(new Date().toISOString());
  await seedOpenRoom();
});
afterEach(async () => resetBusinessTables(lifecycleDatabaseUrl));
afterAll(async () => pool.end());

describe("media upload grants", () => {
  it("derives owner from the room principal and returns an origin-bound grant", async () => {
    const grant = await createUploadGrant(deps(), {
      principal,
      roomId,
      kind: "image",
      originalFileName: "pond.png",
      mime: "image/png",
      sizeBytes: 1200,
      sha256: "a".repeat(64),
      altText: "池塘草圖",
      caption: "觀察",
      correlationId: randomUUID(),
    });
    expect(grant.mediaId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new URL(grant.uploadUrl).origin).toBe("http://127.0.0.1:59000");
    const rows = await pool.query<{ owner_actor_id: string; immutable_key: string | null; staging_key: string }>(
      `SELECT a.owner_actor_id, a.object_key AS immutable_key, g.object_key AS staging_key
       FROM media_asset a JOIN media_upload_grant g USING(media_id)
       WHERE a.media_id = $1`,
      [grant.mediaId],
    );
    expect(rows.rows[0]).toMatchObject({ owner_actor_id: actorId, immutable_key: null });
    expect(rows.rows[0]?.staging_key).toMatch(new RegExp(`^rooms/${roomId}/staging/`));
  });

  it("rejects image alt text and size before writing a media row", async () => {
    await expect(createUploadGrant(deps(), {
      principal,
      roomId,
      kind: "image",
      originalFileName: "pond.png",
      mime: "image/png",
      sizeBytes: 1200,
      sha256: "a".repeat(64),
      altText: "   ",
      caption: null,
      correlationId: randomUUID(),
    })).rejects.toMatchObject({ code: "ALT_REQUIRED" });
    await expect(pool.query("SELECT count(*)::int AS count FROM media_asset")).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
