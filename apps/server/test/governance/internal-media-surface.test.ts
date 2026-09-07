import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createCoreEventPayloadRegistry,
  lifecycleInternalMediaSurfaceContract,
  routes,
  type LifecycleInternalMediaSurfaceRequest,
} from "@learning-orbit/contracts";

import { buildApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { JobStore, claimIdentity, type ClaimedJob } from "../../src/modules/jobs/job-store.js";
import type { MediaSurfaceEraser } from "../../src/modules/lifecycle/internal-media-surface-route.js";
import { RoomEventRepository } from "../../src/modules/rooms/room-event-repository.js";
import { RoomLifecycleService } from "../../src/modules/rooms/lifecycle-service.js";
import { createServiceAssertionTrust } from "../../src/modules/security/service-assertion.js";
import { ServiceAssertionFixtureIssuer } from "../fixtures/service-assertion-issuer.js";
import { resetBusinessTables } from "../db/reset.js";
import {
  lifecycleDatabaseUrl,
  MutableClock,
  seedLifecycleRoom,
  type SeededLifecycleRoom,
} from "../rooms/lifecycle-test-fixture.js";

const pool = new Pool({ connectionString: lifecycleDatabaseUrl, max: 8 });
const issuer = new ServiceAssertionFixtureIssuer();
const trust = createServiceAssertionTrust({
  version: 1,
  keys: [{ issuer: issuer.issuer, keyId: issuer.keyId, publicKeyPem: issuer.publicKeyPem }],
});
const apps: FastifyInstance[] = [];
let clock: MutableClock;
let lifecycle: RoomLifecycleService;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

class RecordingEraser implements MediaSurfaceEraser {
  readonly erased: string[] = [];

  async eraseRoomObjects(_roomId: string, objectKeys: readonly string[]): Promise<void> {
    this.erased.push(...objectKeys);
  }
}

async function makeApp(eraser?: MediaSurfaceEraser): Promise<FastifyInstance> {
  const app = await buildApp({
    pool,
    clock,
    serviceAssertionTrust: trust,
    ...(eraser ? { mediaSurfaceEraser: eraser } : {}),
    config: {
      allowedOrigins: ["https://app.learning-orbit.test"],
      publicBaseOrigin: "https://app.learning-orbit.test",
    },
  });
  apps.push(app);
  return app;
}

/** A deletion job whose media surface is frozen and whose worker job is claimed. */
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
  const claims = await new JobStore(pool, "worker-lifecycle-1").claim(10);
  const claim = claims.find(({ jobType }) => jobType === "room.delete-surface.v1");
  if (!claim) throw new Error("EXPECTED_SURFACE_JOB_CLAIM");
  return { claim, deletionJobId };
}

async function seedRoomMedia(room: SeededLifecycleRoom): Promise<string> {
  const mediaId = randomUUID();
  await pool.query(
    `INSERT INTO media_asset(media_id, room_id, owner_actor_id, kind, state,
                             original_file_name, declared_mime, size_bytes,
                             declared_sha256, sha256, alt_text, object_key,
                             promotion_correlation_id)
     SELECT $1,$2,actor_id,'image','ready','leaf.png','image/png',2048,$3,$3,'葉片',$4,$5
     FROM room_member WHERE room_member_id = $6`,
    [mediaId, room.roomId, sha("leaf"), `rooms/${room.roomId}/media/${mediaId}`,
      randomUUID(), room.memberIds[0]],
  );
  await pool.query(
    `INSERT INTO media_derivative(derivative_id, media_id, kind, object_key, mime, size_bytes, sha256)
     VALUES($1,$2,'thumbnail',$3,'image/webp',512,$4)`,
    [randomUUID(), mediaId, `rooms/${room.roomId}/media/${mediaId}/thumb`, sha("thumb")],
  );
  return mediaId;
}

function requestFor(claim: ClaimedJob, deletionJobId: string): LifecycleInternalMediaSurfaceRequest {
  return {
    ...claimIdentity(claim),
    deletionJobId,
    surface: "media",
  } as LifecycleInternalMediaSurfaceRequest;
}

async function post(
  app: FastifyInstance,
  body: LifecycleInternalMediaSurfaceRequest,
  assertion?: string,
) {
  const response = await app.inject({
    method: "POST",
    url: routes.internal.lifecycle.mediaSurface(),
    headers: {
      "x-lo-service-assertion": assertion ?? issuer.sign({
        subject: body.workerId,
        audience: "internal.lifecycle.mediaSurface",
        body,
        now: clock.now(),
      }).raw,
    },
    payload: body,
  });
  return {
    statusCode: response.statusCode,
    body: lifecycleInternalMediaSurfaceContract.parseResponse(response.json()),
  };
}

const surfaceStatus = async (deletionJobId: string) => (await pool.query(
  "SELECT status FROM deletion_surface_manifest WHERE deletion_job_id = $1 AND surface = 'media'",
  [deletionJobId],
)).rows[0];

beforeAll(async () => runMigrations(lifecycleDatabaseUrl!, "infra/postgres/migrations"));
beforeEach(async () => {
  await resetBusinessTables(lifecycleDatabaseUrl!);
  clock = new MutableClock("2026-08-30T08:00:00.000Z");
  lifecycle = new RoomLifecycleService(
    new RoomEventRepository(pool, createCoreEventPayloadRegistry(), clock),
    clock,
  );
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await resetBusinessTables(lifecycleDatabaseUrl!);
});
afterAll(async () => pool.end());

describe("signed internal media surface deletion", () => {
  it("verifies an empty media surface without needing a store", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, deletionJobId } = await seedMediaSurfaceJob(room, 0);
    const app = await makeApp();

    expect(await post(app, requestFor(claim, deletionJobId))).toEqual({
      statusCode: 200,
      body: { status: "completed", surface: "media", verifiedItemCount: 0 },
    });
    expect(await surfaceStatus(deletionJobId)).toEqual({ status: "verified" });
  });

  it("stays retryable, and keeps every row, when no store can prove the objects are gone", async () => {
    const room = await seedLifecycleRoom(pool);
    const mediaId = await seedRoomMedia(room);
    const { claim, deletionJobId } = await seedMediaSurfaceJob(room, 1);
    const app = await makeApp();

    const response = await post(app, requestFor(claim, deletionJobId));

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      status: "retryable",
      code: "MEDIA_SURFACE_STORE_UNAVAILABLE",
    });
    expect(await surfaceStatus(deletionJobId)).toEqual({ status: "frozen" });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM media_asset WHERE media_id = $1", [mediaId],
    )).rows[0]).toEqual({ count: 1 });
  });

  it("erases originals and derivatives, then verifies the surface", async () => {
    const room = await seedLifecycleRoom(pool);
    const mediaId = await seedRoomMedia(room);
    const { claim, deletionJobId } = await seedMediaSurfaceJob(room, 1);
    const eraser = new RecordingEraser();
    const app = await makeApp(eraser);

    expect(await post(app, requestFor(claim, deletionJobId))).toEqual({
      statusCode: 200,
      body: { status: "completed", surface: "media", verifiedItemCount: 1 },
    });
    expect(eraser.erased.sort()).toEqual([
      `rooms/${room.roomId}/media/${mediaId}`,
      `rooms/${room.roomId}/media/${mediaId}/thumb`,
    ]);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM media_asset WHERE room_id = $1", [room.roomId],
    )).rows[0]).toEqual({ count: 0 });
    expect(await surfaceStatus(deletionJobId)).toEqual({ status: "verified" });
  });

  it("holds the surface while a media job is still claimable", async () => {
    const room = await seedLifecycleRoom(pool);
    await seedRoomMedia(room);
    const { claim, deletionJobId } = await seedMediaSurfaceJob(room, 1);
    await pool.query(
      `INSERT INTO worker_job(job_id, job_type, room_id, source_event_id, dedupe_key,
                              correlation_id, payload, run_after)
       VALUES($1,'media.process.v1',$2,NULL,$3,$4,$5, now())`,
      [randomUUID(), room.roomId, `media.process.v1:${randomUUID()}`, randomUUID(), {}],
    );
    const app = await makeApp(new RecordingEraser());

    const response = await post(app, requestFor(claim, deletionJobId));

    expect(response.body).toMatchObject({
      status: "retryable",
      code: "MEDIA_SURFACE_NOT_QUIESCENT",
    });
    expect(await surfaceStatus(deletionJobId)).toEqual({ status: "frozen" });
  });

  it("answers a redelivered verification without deleting twice", async () => {
    const room = await seedLifecycleRoom(pool);
    await seedRoomMedia(room);
    const { claim, deletionJobId } = await seedMediaSurfaceJob(room, 1);
    const eraser = new RecordingEraser();
    const app = await makeApp(eraser);
    const request = requestFor(claim, deletionJobId);

    expect((await post(app, request)).body).toMatchObject({ status: "completed" });
    expect((await post(app, request)).body).toEqual({
      status: "already_verified",
      surface: "media",
      verifiedItemCount: 1,
    });
    expect(eraser.erased).toHaveLength(2);
  });

  it("writes nothing for a superseded claim or an unsigned request", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, deletionJobId } = await seedMediaSurfaceJob(room, 0);
    const app = await makeApp();

    expect(await post(app, requestFor(claim, deletionJobId), "not-a-signature")).toEqual({
      statusCode: 401,
      body: { status: "rejected", code: "SERVICE_ASSERTION_INVALID" },
    });
    await pool.query(
      `UPDATE worker_job SET claim_generation = claim_generation + 1, claim_token = $2
       WHERE job_id = $1`,
      [claim.jobId, randomUUID()],
    );
    expect(await post(app, requestFor(claim, deletionJobId))).toEqual({
      statusCode: 409,
      body: { status: "rejected", code: "JOB_CLAIM_STALE" },
    });
    expect(await surfaceStatus(deletionJobId)).toEqual({ status: "frozen" });
  });
});
