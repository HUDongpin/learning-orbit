import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  lifecycleInternalMediaSurfaceContract,
  routes,
  type LifecycleInternalMediaSurfaceRequest,
} from "@learning-orbit/contracts";

import { buildApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { JobStore, claimIdentity, type ClaimedJob } from "../../src/modules/jobs/job-store.js";
import type { StoreCallControl } from "../../src/modules/media/media-store.js";
import { MemoryMediaStore } from "../../src/modules/media/s3-media-store.js";
import { createServiceAssertionTrust } from "../../src/modules/security/service-assertion.js";
import { ServiceAssertionFixtureIssuer } from "../fixtures/service-assertion-issuer.js";
import { resetBusinessTables } from "../db/reset.js";
import {
  lifecycleDatabaseUrl,
  MutableClock,
  seedLifecycleRoom,
  type SeededLifecycleRoom,
} from "../rooms/lifecycle-test-fixture.js";

/**
 * The wiring, end to end through `buildApp`: a room holding media can only
 * finish its media surface where a real object store was actually composed,
 * and the erase that finishes it has to have removed the bytes.
 *
 * Every assertion here is about the bucket, not about a stub. A test that only
 * watches an injected recorder cannot tell a wired store from an unwired one.
 */

const pool = new Pool({ connectionString: lifecycleDatabaseUrl, max: 8 });
const issuer = new ServiceAssertionFixtureIssuer();
const trust = createServiceAssertionTrust({
  version: 1,
  keys: [{ issuer: issuer.issuer, keyId: issuer.keyId, publicKeyPem: issuer.publicKeyPem }],
});
const BROWSER_ORIGIN = "http://127.0.0.1:59000";
const apps: FastifyInstance[] = [];
let clock: MutableClock;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const bytes = (value: string) => new TextEncoder().encode(value);

/** A store whose delete leg can be made to fail the way a provider outage does. */
class OutageProneStore extends MemoryMediaStore {
  failure: string | null = null;

  override async deleteObjects(objectKeys: string[], control: StoreCallControl): Promise<void> {
    if (this.failure) throw new Error(this.failure);
    await super.deleteObjects(objectKeys, control);
  }
}

/**
 * `storageBrowserOrigins` is what composes the media surface in or out, so a
 * store is only ever handed in together with a non-empty origin list - the
 * same pairing production has.
 */
async function makeApp(store?: MemoryMediaStore): Promise<FastifyInstance> {
  const app = await buildApp({
    pool,
    clock,
    serviceAssertionTrust: trust,
    ...(store ? { mediaStore: store } : {}),
    config: {
      allowedOrigins: ["https://app.learning-orbit.test"],
      publicBaseOrigin: "https://app.learning-orbit.test",
      storageBrowserOrigins: store ? [BROWSER_ORIGIN] : [],
    },
  });
  apps.push(app);
  return app;
}

async function seedMediaSurfaceJob(room: SeededLifecycleRoom, expectedItemCount: number): Promise<{
  claim: ClaimedJob;
  deletionJobId: string;
}> {
  const deletionJobId = randomUUID();
  const correlationId = randomUUID();
  await pool.query(
    `INSERT INTO deletion_job(deletion_job_id, correlation_id, room_id, room_ref_sha256,
                              request_kind, status, owner_teacher_id, requested_by_teacher_id)
     VALUES($1,$2,$3,$4,'teacher','running',$5,$5)`,
    [deletionJobId, correlationId, room.roomId, sha(room.roomId), room.teacherId],
  );
  await pool.query(
    `INSERT INTO deletion_surface_manifest(deletion_job_id, surface, expected_item_count, status, frozen_at)
     VALUES($1,'media',$2,'frozen',now())`,
    [deletionJobId, expectedItemCount],
  );
  await pool.query(
    `INSERT INTO worker_job(job_id, job_type, room_id, source_event_id, dedupe_key,
                            correlation_id, payload, run_after)
     VALUES($1,'room.delete-surface.v1',NULL,NULL,$2,$3,$4, now())`,
    [randomUUID(), `room.delete-surface.v1:${deletionJobId}:media`, correlationId,
      { deletionJobId, surface: "media" }],
  );
  const claims = await new JobStore(pool, "worker-lifecycle-erasure").claim(10);
  const claim = claims.find(({ jobType }) => jobType === "room.delete-surface.v1");
  if (!claim) throw new Error("EXPECTED_SURFACE_JOB_CLAIM");
  return { claim, deletionJobId };
}

/**
 * One ready asset with one derivative. `originalKey` is settable so a row that
 * names an object outside the room - the shape a mislabelled or tampered
 * manifest would have - can be seeded too.
 */
async function seedRoomMedia(
  room: SeededLifecycleRoom,
  originalKey?: string,
): Promise<{ mediaId: string; originalKey: string; derivativeKey: string }> {
  const mediaId = randomUUID();
  const original = originalKey ?? `rooms/${room.roomId}/original/${mediaId}`;
  const derivative = `rooms/${room.roomId}/derivative/${mediaId}/sanitized_image`;
  await pool.query(
    `INSERT INTO media_asset(media_id, room_id, owner_actor_id, kind, state,
                             original_file_name, declared_mime, size_bytes,
                             declared_sha256, sha256, alt_text, object_key,
                             promotion_correlation_id)
     SELECT $1,$2,actor_id,'image','ready','leaf.png','image/png',2048,$3,$3,'葉片',$4,$5
     FROM room_member WHERE room_member_id = $6`,
    [mediaId, room.roomId, sha("leaf"), original, randomUUID(), room.memberIds[0]],
  );
  await pool.query(
    `INSERT INTO media_derivative(derivative_id, media_id, kind, object_key, mime, size_bytes, sha256)
     VALUES($1,$2,'sanitized_image',$3,'image/webp',512,$4)`,
    [randomUUID(), mediaId, derivative, sha("thumb")],
  );
  return { mediaId, originalKey: original, derivativeKey: derivative };
}

/**
 * An upload that never became a ready asset: the asset row carries no
 * `object_key`, so the grant row is the only thing that names the bytes.
 *
 * `abandoned` seeds the promotion variant - a copy to the immutable original
 * was started and its outcome never landed, leaving a second object that only
 * `promotion_destination_key` points at. Both grants are past their fence and
 * closed, so the room is quiescent and the surface is allowed to proceed.
 */
async function seedRoomUploadGrant(
  room: SeededLifecycleRoom,
  options: { readonly abandoned?: boolean } = {},
): Promise<{ mediaId: string; stagingKey: string; destinationKey: string | null }> {
  const mediaId = randomUUID();
  const grantId = randomUUID();
  const stagingKey = `rooms/${room.roomId}/staging/${grantId}`;
  const destinationKey = options.abandoned ? `rooms/${room.roomId}/original/${mediaId}` : null;
  await pool.query(
    `INSERT INTO media_asset(media_id, room_id, owner_actor_id, kind, state,
                             original_file_name, declared_mime, size_bytes,
                             declared_sha256, alt_text, failure_code)
     SELECT $1,$2,actor_id,'image',$3::media_state,'leaf.png','image/png',2048,$4,'葉片',$5
     FROM room_member WHERE room_member_id = $6`,
    [mediaId, room.roomId, options.abandoned ? "failed" : "upload_pending", sha("leaf"),
      options.abandoned ? "PROMOTION_ABANDONED" : null, room.memberIds[0]],
  );
  await pool.query(
    `INSERT INTO media_upload_grant(
       grant_id, media_id, room_id, object_key, state, correlation_id,
       reserved_at, expires_at, write_not_after, closed_at,
       promotion_source_etag, promotion_sha256, promotion_destination_key,
       promotion_correlation_id, promotion_started_at, promotion_write_not_after)
     VALUES($1,$2,$3,$4,'closed',$5,
       now() - interval '2 hours', now() - interval '1 hour',
       now() - interval '30 minutes', now() - interval '20 minutes',
       CASE WHEN $6::text IS NULL THEN NULL ELSE 'etag-abandoned' END,
       CASE WHEN $6::text IS NULL THEN NULL ELSE $7::char(64) END,
       $6::text,
       CASE WHEN $6::text IS NULL THEN NULL ELSE $8::uuid END,
       CASE WHEN $6::text IS NULL THEN NULL ELSE now() - interval '90 minutes' END,
       CASE WHEN $6::text IS NULL THEN NULL ELSE now() - interval '40 minutes' END)`,
    [grantId, mediaId, room.roomId, stagingKey, randomUUID(),
      destinationKey, sha("promoted-original"), randomUUID()],
  );
  return { mediaId, stagingKey, destinationKey };
}

function requestFor(claim: ClaimedJob, deletionJobId: string): LifecycleInternalMediaSurfaceRequest {
  return {
    ...claimIdentity(claim),
    deletionJobId,
    surface: "media",
  } as LifecycleInternalMediaSurfaceRequest;
}

async function post(app: FastifyInstance, body: LifecycleInternalMediaSurfaceRequest) {
  const response = await app.inject({
    method: "POST",
    url: routes.internal.lifecycle.mediaSurface(),
    headers: {
      "x-lo-service-assertion": issuer.sign({
        subject: body.workerId,
        audience: "internal.lifecycle.mediaSurface",
        body,
        now: clock.now(),
      }).raw,
    },
    payload: body,
  });
  return lifecycleInternalMediaSurfaceContract.parseResponse(response.json());
}

const surfaceStatus = async (deletionJobId: string): Promise<string | undefined> => (await pool.query<{
  status: string;
}>(
  "SELECT status FROM deletion_surface_manifest WHERE deletion_job_id = $1 AND surface = 'media'",
  [deletionJobId],
)).rows[0]?.status;

const assetCount = async (roomId: string): Promise<number> => (await pool.query<{ count: number }>(
  "SELECT count(*)::int AS count FROM media_asset WHERE room_id = $1",
  [roomId],
)).rows[0]!.count;

const grantCount = async (roomId: string): Promise<number> => (await pool.query<{ count: number }>(
  "SELECT count(*)::int AS count FROM media_upload_grant WHERE room_id = $1",
  [roomId],
)).rows[0]!.count;

beforeAll(async () => runMigrations(lifecycleDatabaseUrl!, "infra/postgres/migrations"));
beforeEach(async () => {
  await resetBusinessTables(lifecycleDatabaseUrl!);
  clock = new MutableClock("2026-08-30T08:00:00.000Z");
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await resetBusinessTables(lifecycleDatabaseUrl!);
});
afterAll(async () => pool.end());

describe("media surface erasure wired from a composed media store", () => {
  it("erases the room's objects from the bucket and verifies the surface", async () => {
    const room = await seedLifecycleRoom(pool);
    const { originalKey, derivativeKey } = await seedRoomMedia(room);
    const neighbourKey = `rooms/${randomUUID()}/original/${randomUUID()}`;
    const store = new OutageProneStore(BROWSER_ORIGIN);
    store.put(originalKey, bytes("leaf"));
    store.put(derivativeKey, bytes("leaf-small"));
    store.put(neighbourKey, bytes("another classroom"));
    const { claim, deletionJobId } = await seedMediaSurfaceJob(room, 1);

    const response = await post(await makeApp(store), requestFor(claim, deletionJobId));

    expect(response).toEqual({ status: "completed", surface: "media", verifiedItemCount: 1 });
    expect(await surfaceStatus(deletionJobId)).toBe("verified");
    expect(await assetCount(room.roomId)).toBe(0);
    // The bytes, not a recorded intention to remove them.
    expect([...store.objects.keys()]).toEqual([neighbourKey]);
  });

  it("stays retryable, and keeps the bytes, when no media store was composed", async () => {
    const room = await seedLifecycleRoom(pool);
    const { originalKey, derivativeKey } = await seedRoomMedia(room);
    const unreachable = new OutageProneStore(BROWSER_ORIGIN);
    unreachable.put(originalKey, bytes("leaf"));
    unreachable.put(derivativeKey, bytes("leaf-small"));
    const { claim, deletionJobId } = await seedMediaSurfaceJob(room, 1);

    const response = await post(await makeApp(), requestFor(claim, deletionJobId));

    expect(response).toMatchObject({
      status: "retryable",
      code: "MEDIA_SURFACE_STORE_UNAVAILABLE",
    });
    expect(await surfaceStatus(deletionJobId)).toBe("frozen");
    expect(await assetCount(room.roomId)).toBe(1);
    expect(unreachable.objects.size).toBe(2);
  });

  it("stays retryable, and keeps every row, when the store cannot delete", async () => {
    const room = await seedLifecycleRoom(pool);
    const { originalKey } = await seedRoomMedia(room);
    const store = new OutageProneStore(BROWSER_ORIGIN);
    store.put(originalKey, bytes("leaf"));
    store.failure = "STORAGE_PROVIDER_UNAVAILABLE";
    const { claim, deletionJobId } = await seedMediaSurfaceJob(room, 1);

    const response = await post(await makeApp(store), requestFor(claim, deletionJobId));

    expect(response).toMatchObject({
      status: "retryable",
      code: "MEDIA_SURFACE_STORE_UNAVAILABLE",
    });
    expect(await surfaceStatus(deletionJobId)).toBe("frozen");
    expect(await assetCount(room.roomId)).toBe(1);
    expect(store.objects.has(originalKey)).toBe(true);
  });

  it("refuses a row naming another room's object, and leaves that object alone", async () => {
    const room = await seedLifecycleRoom(pool);
    const neighbourRoomId = randomUUID();
    const foreignKey = `rooms/${neighbourRoomId}/original/${randomUUID()}`;
    const { derivativeKey } = await seedRoomMedia(room, foreignKey);
    const store = new OutageProneStore(BROWSER_ORIGIN);
    store.put(foreignKey, bytes("another classroom"));
    store.put(derivativeKey, bytes("leaf-small"));
    const { claim, deletionJobId } = await seedMediaSurfaceJob(room, 1);

    const response = await post(await makeApp(store), requestFor(claim, deletionJobId));

    expect(response).toMatchObject({
      status: "retryable",
      code: "MEDIA_SURFACE_STORE_UNAVAILABLE",
    });
    expect(await surfaceStatus(deletionJobId)).toBe("frozen");
    expect(await assetCount(room.roomId)).toBe(1);
    // Neither the other room's object nor this room's own was removed: the
    // refusal is of the manifest, not of one key inside it.
    expect([...store.objects.keys()].sort()).toEqual([foreignKey, derivativeKey].sort());
  });

  it("erases the staging copy and an abandoned promotion's original, which no asset row names", async () => {
    const room = await seedLifecycleRoom(pool);
    const pending = await seedRoomUploadGrant(room);
    const abandoned = await seedRoomUploadGrant(room, { abandoned: true });
    const neighbourKey = `rooms/${randomUUID()}/staging/${randomUUID()}`;
    const store = new OutageProneStore(BROWSER_ORIGIN);
    store.put(pending.stagingKey, bytes("a student's upload"));
    store.put(abandoned.stagingKey, bytes("a student's upload"));
    store.put(abandoned.destinationKey!, bytes("a student's upload"));
    store.put(neighbourKey, bytes("another classroom"));
    const { claim, deletionJobId } = await seedMediaSurfaceJob(room, 2);

    const response = await post(await makeApp(store), requestFor(claim, deletionJobId));

    expect(response).toEqual({ status: "completed", surface: "media", verifiedItemCount: 2 });
    expect(await surfaceStatus(deletionJobId)).toBe("verified");
    expect(await assetCount(room.roomId)).toBe(0);
    expect(await grantCount(room.roomId)).toBe(0);
    // The receipt says the room's media is gone; the bucket has to agree, for
    // the two keys the grant row was the only pointer to as much as for any
    // other.
    expect([...store.objects.keys()]).toEqual([neighbourKey]);
  });

  it("keeps a grant's bytes and rows, and stays retryable, when the store cannot delete", async () => {
    const room = await seedLifecycleRoom(pool);
    const abandoned = await seedRoomUploadGrant(room, { abandoned: true });
    const store = new OutageProneStore(BROWSER_ORIGIN);
    store.put(abandoned.stagingKey, bytes("a student's upload"));
    store.put(abandoned.destinationKey!, bytes("a student's upload"));
    store.failure = "STORAGE_PROVIDER_UNAVAILABLE";
    const { claim, deletionJobId } = await seedMediaSurfaceJob(room, 1);

    const response = await post(await makeApp(store), requestFor(claim, deletionJobId));

    expect(response).toMatchObject({
      status: "retryable",
      code: "MEDIA_SURFACE_STORE_UNAVAILABLE",
    });
    expect(await surfaceStatus(deletionJobId)).toBe("frozen");
    // The grant row is what a retry re-reads the keys from, so it must outlive
    // an outage exactly as the bytes do.
    expect(await assetCount(room.roomId)).toBe(1);
    expect(await grantCount(room.roomId)).toBe(1);
    expect([...store.objects.keys()].sort())
      .toEqual([abandoned.stagingKey, abandoned.destinationKey!].sort());
  });

  it("answers a redelivered verification without a second erase", async () => {
    const room = await seedLifecycleRoom(pool);
    const { originalKey, derivativeKey } = await seedRoomMedia(room);
    const store = new OutageProneStore(BROWSER_ORIGIN);
    store.put(originalKey, bytes("leaf"));
    store.put(derivativeKey, bytes("leaf-small"));
    const { claim, deletionJobId } = await seedMediaSurfaceJob(room, 1);
    const app = await makeApp(store);
    const request = requestFor(claim, deletionJobId);

    expect(await post(app, request)).toMatchObject({ status: "completed" });
    // A provider that has become unreachable must not turn a surface that is
    // already verified back into a retry.
    store.failure = "STORAGE_PROVIDER_UNAVAILABLE";
    expect(await post(app, request)).toEqual({
      status: "already_verified",
      surface: "media",
      verifiedItemCount: 1,
    });
    expect(store.objects.size).toBe(0);
  });
});
