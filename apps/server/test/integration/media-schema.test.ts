import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";
import { resetBusinessTables } from "../db/reset.js";
import { serializeMediaAttachment, type MediaAssetRecord } from "../../src/modules/media/media-asset-record.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for media schema tests");
const pool = new Pool({ connectionString: databaseUrl, max: 4 });

function record(overrides: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
  const now = new Date("2026-08-28T09:12:00.000Z");
  return {
    mediaId: randomUUID(), roomId: randomUUID(), ownerActorId: randomUUID(), kind: "image", state: "ready",
    originalFileName: "pond.png", declaredMime: "image/png", detectedMime: "image/png", sizeBytes: 1200,
    declaredSha256: "a".repeat(64), sha256: "a".repeat(64), altText: "池塘草圖", caption: "觀察",
    objectKey: "rooms/room/original/media", failureCode: null, promotionCorrelationId: randomUUID(), outcomeTransitionId: null,
    createdAt: now, updatedAt: now, ...overrides,
  };
}

beforeAll(async () => runMigrations(databaseUrl, "infra/postgres/migrations"));
beforeEach(async () => resetBusinessTables(databaseUrl));
afterEach(async () => resetBusinessTables(databaseUrl));
afterAll(async () => pool.end());

describe("media persistence schema", () => {
  it("creates media tables and keeps public serialization closed", async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name`,
      [["media_asset", "media_upload_grant", "media_derivative", "media_attachment_binding", "media_write_fence"]],
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "media_asset", "media_attachment_binding", "media_derivative", "media_upload_grant", "media_write_fence",
    ]);
    const view = serializeMediaAttachment(record({ roomId: "room-secret", ownerActorId: "owner-secret", objectKey: "storage-secret" }));
    expect(view).not.toHaveProperty("roomId");
    expect(view).not.toHaveProperty("ownerActorId");
    expect(view).not.toHaveProperty("objectKey");
  });

  it("rejects image assets without meaningful alt text or promoted identity", async () => {
    const teacherId = randomUUID();
    const roomId = randomUUID();
    const novaId = randomUUID();
    const actorId = randomUUID();
    const memberId = randomUUID();
    await pool.query("INSERT INTO teacher_account(teacher_id,email) VALUES($1,$2)", [teacherId, `media-${teacherId}@example.test`]);
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
    await expect(pool.query(
      `INSERT INTO media_asset(media_id,room_id,owner_actor_id,kind,state,original_file_name,declared_mime,size_bytes,declared_sha256,alt_text)
       VALUES($1,$2,$3,'image','upload_pending','x.png','image/png',100,$4,'   ')`,
      [randomUUID(), roomId, actorId, "a".repeat(64)],
    )).rejects.toThrow();
  });
});
