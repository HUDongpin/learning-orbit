import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";
import { MediaStagingJanitor } from "../../src/modules/media/media-staging-janitor.js";
import { MemoryMediaStore } from "../../src/modules/media/s3-media-store.js";
import { resetBusinessTables } from "../db/reset.js";
import {
  lifecycleDatabaseUrl,
  MutableClock,
  seedLifecycleRoom,
  type SeededLifecycleRoom,
} from "../rooms/lifecycle-test-fixture.js";

const pool = new Pool({ connectionString: lifecycleDatabaseUrl, max: 8 });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
let clock: MutableClock;

/**
 * Fences are expressed as intervals from the database's own `now()`. The
 * janitor reads the fence in database time on purpose - an application clock
 * could sweep a still-writable staging key - so a test that drove it from an
 * injected clock would be testing something the janitor deliberately ignores.
 */
interface SeedOptions {
  readonly grantState?: "active" | "promoted" | "revoked" | "closed";
  /** SQL interval from now(), e.g. "-1 second" (due) or "1 hour" (not yet). */
  readonly writeFence: string;
  readonly promotionFence?: string;
  readonly mediaState?: "upload_pending" | "uploaded" | "failed";
  readonly failureCode?: string | null;
}

async function seedGrant(room: SeededLifecycleRoom, options: SeedOptions) {
  const mediaId = randomUUID();
  const grantId = randomUUID();
  const stagingKey = `staging/${mediaId}`;
  const destinationKey = `rooms/${room.roomId}/media/${mediaId}`;
  const mediaState = options.mediaState ?? "upload_pending";
  const promoted = mediaState === "uploaded";
  await pool.query(
    `INSERT INTO media_asset(media_id, room_id, owner_actor_id, kind, state,
                             original_file_name, declared_mime, size_bytes,
                             declared_sha256, sha256, alt_text, object_key,
                             promotion_correlation_id, failure_code)
     SELECT $1,$2,actor_id,'image',$3::media_state,'leaf.png','image/png',2048,$4,
            $5,'葉片',$6,$7,$8
     FROM room_member WHERE room_member_id = $9`,
    [mediaId, room.roomId, mediaState, sha("leaf"),
      promoted ? sha("leaf") : null, promoted ? destinationKey : null,
      promoted ? randomUUID() : null, options.failureCode ?? null, room.memberIds[0]],
  );
  const hasPromotion = options.promotionFence !== undefined;
  await pool.query(
    `INSERT INTO media_upload_grant(grant_id, media_id, room_id, object_key, state,
                                    correlation_id, reserved_at, signed_at, expires_at,
                                    write_not_after, activated_at,
                                    promotion_source_etag, promotion_sha256,
                                    promotion_destination_key, promotion_correlation_id,
                                    promotion_started_at, promotion_write_not_after)
     VALUES($1,$2,$3,$4,$5::media_upload_grant_state,$6,
            now() - interval '1 hour', now() - interval '1 hour',
            least(now() + ($7)::interval, now() + ($7)::interval),
            now() + ($7)::interval, now() - interval '1 hour',
            $8,$9,$10,$11,
            CASE WHEN $12::text IS NULL THEN NULL ELSE now() - interval '1 hour' END,
            CASE WHEN $12::text IS NULL THEN NULL ELSE now() + ($12)::interval END)`,
    [grantId, mediaId, room.roomId, stagingKey, options.grantState ?? "active",
      randomUUID(), options.writeFence,
      hasPromotion ? "etag-1" : null, hasPromotion ? sha("leaf") : null,
      hasPromotion ? destinationKey : null, hasPromotion ? randomUUID() : null,
      options.promotionFence ?? null],
  );
  return { mediaId, grantId, stagingKey, destinationKey };
}

const grantRow = async (grantId: string) => (await pool.query<{ state: string }>(
  "SELECT state::text AS state FROM media_upload_grant WHERE grant_id = $1", [grantId],
)).rows[0];

beforeAll(async () => runMigrations(lifecycleDatabaseUrl!, "infra/postgres/migrations"));
beforeEach(async () => {
  await resetBusinessTables(lifecycleDatabaseUrl!);
  clock = new MutableClock("2026-08-30T08:00:00.000Z");
});
afterAll(async () => pool.end());

describe("media staging janitor", () => {
  it("leaves a grant alone until its write fence has actually passed", async () => {
    const room = await seedLifecycleRoom(pool);
    const seeded = await seedGrant(room, { writeFence: "1 hour" });
    const store = new MemoryMediaStore();
    store.put(seeded.stagingKey, Buffer.from("leaf"));

    const result = await new MediaStagingJanitor(pool, store, clock).sweep();

    expect(result).toMatchObject({ grantsClosed: 0, stagingObjectsRemoved: 0 });
    expect(store.objects.has(seeded.stagingKey)).toBe(true);
    expect(await grantRow(seeded.grantId)).toEqual({ state: "active" });
  });

  it("sweeps staging and closes the grant at the fence", async () => {
    const room = await seedLifecycleRoom(pool);
    const seeded = await seedGrant(room, { writeFence: "-1 second" });
    const store = new MemoryMediaStore();
    store.put(seeded.stagingKey, Buffer.from("leaf"));

    const result = await new MediaStagingJanitor(pool, store, clock).sweep();

    expect(result).toMatchObject({ grantsClosed: 1, stagingObjectsRemoved: 1 });
    expect(store.objects.has(seeded.stagingKey)).toBe(false);
    expect(await grantRow(seeded.grantId)).toEqual({ state: "closed" });
  });

  it("honours the later promotion fence, not just the upload fence", async () => {
    const room = await seedLifecycleRoom(pool);
    const seeded = await seedGrant(room, {
      grantState: "promoted",
      mediaState: "uploaded",
      writeFence: "-1 second",
      promotionFence: "1 hour",
    });
    const store = new MemoryMediaStore();
    store.put(seeded.stagingKey, Buffer.from("leaf"));
    store.put(seeded.destinationKey, Buffer.from("leaf"));
    const janitor = new MediaStagingJanitor(pool, store, clock);

    // The upload fence has passed but the promotion fence has not.
    expect(await janitor.sweep()).toMatchObject({ grantsClosed: 0 });
    expect(store.objects.has(seeded.stagingKey)).toBe(true);

    await pool.query(
      "UPDATE media_upload_grant SET promotion_write_not_after = now() - interval '1 second' WHERE grant_id = $1",
      [seeded.grantId],
    );
    expect(await janitor.sweep()).toMatchObject({ grantsClosed: 1, stagingObjectsRemoved: 1 });
    // The immutable original survives; only staging is swept.
    expect(store.objects.has(seeded.stagingKey)).toBe(false);
    expect(store.objects.has(seeded.destinationKey)).toBe(true);
  });

  it("keeps an abandoned promotion's rows while its reconcile job can still retry", async () => {
    const room = await seedLifecycleRoom(pool);
    const seeded = await seedGrant(room, {
      grantState: "closed",
      mediaState: "failed",
      failureCode: "PROMOTION_ABANDONED",
      writeFence: "-1 second",
    });
    await pool.query(
      `INSERT INTO worker_job(job_id, job_type, room_id, source_event_id, dedupe_key,
                              correlation_id, payload, run_after, status)
       VALUES($1,'media.reconcile-upload.v1',$2,NULL,$3,$4,$5, now(), 'retryable')`,
      [randomUUID(), room.roomId, `media.reconcile-upload.v1:${seeded.mediaId}`,
        randomUUID(), { mediaId: seeded.mediaId }],
    );
    const store = new MemoryMediaStore();
    const janitor = new MediaStagingJanitor(pool, store, clock);

    expect(await janitor.sweep()).toMatchObject({ abandonedRowsRemoved: 0, grantsClosed: 1 });
    expect(await grantRow(seeded.grantId)).toEqual({ state: "closed" });

    // Once the reconcile job is durably finished there is no retry target left.
    await pool.query(
      "UPDATE worker_job SET status = 'succeeded' WHERE dedupe_key = $1",
      [`media.reconcile-upload.v1:${seeded.mediaId}`],
    );
    expect(await janitor.sweep()).toMatchObject({ abandonedRowsRemoved: 1 });
    expect(await grantRow(seeded.grantId)).toBeUndefined();
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM media_asset WHERE media_id = $1", [seeded.mediaId],
    )).rows[0]).toEqual({ count: 0 });
  });

  it("never closes a grant whose staging object it could not prove gone", async () => {
    const room = await seedLifecycleRoom(pool);
    const seeded = await seedGrant(room, { writeFence: "-1 second" });
    const store = new MemoryMediaStore();
    store.put(seeded.stagingKey, Buffer.from("leaf"));
    store.deleteObjects = async () => { throw new Error("STORAGE_PROVIDER_UNAVAILABLE"); };

    const result = await new MediaStagingJanitor(pool, store, clock).sweep();

    expect(result).toMatchObject({ deferred: 1, grantsClosed: 0, stagingObjectsRemoved: 0 });
    expect(await grantRow(seeded.grantId)).toEqual({ state: "active" });
  });

  it("is safe to run twice over the same fence", async () => {
    const room = await seedLifecycleRoom(pool);
    const seeded = await seedGrant(room, { writeFence: "-1 second" });
    const store = new MemoryMediaStore();
    store.put(seeded.stagingKey, Buffer.from("leaf"));
    const janitor = new MediaStagingJanitor(pool, store, clock);

    await janitor.sweep();
    const second = await janitor.sweep();

    expect(second).toMatchObject({ abandonedRowsRemoved: 0 });
    expect(await grantRow(seeded.grantId)).toEqual({ state: "closed" });
  });
});
