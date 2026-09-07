import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCoreEventPayloadRegistry, teacherRoomExportContract } from "@learning-orbit/contracts";

import { runMigrations } from "../../src/db/migrate.js";
import { GovernanceService } from "../../src/modules/governance/governance-service.js";
import {
  InternalMediaSurfaceRoute,
  type MediaSurfaceEraser,
} from "../../src/modules/lifecycle/internal-media-surface-route.js";
import { JobStore, claimIdentity } from "../../src/modules/jobs/job-store.js";
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
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const RETENTION_POLICY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const RETENTION_POLICY_VERSION = "deletion-closure-fixture";
let clock: MutableClock;

class RecordingEraser implements MediaSurfaceEraser {
  readonly erased: string[] = [];
  fail = false;

  async eraseRoomObjects(_roomId: string, objectKeys: readonly string[]): Promise<void> {
    if (this.fail) throw new Error("STORAGE_PROVIDER_UNAVAILABLE");
    this.erased.push(...objectKeys);
  }
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

/** Run the media surface job the way the worker does, through the signed route. */
async function runMediaSurfaceJob(eraser?: MediaSurfaceEraser) {
  const claims = await new JobStore(pool, "deletion-worker").claim(20);
  const claim = claims.find(({ jobType, payload }) => jobType === "room.delete-surface.v1"
    && (payload as { surface?: string }).surface === "media");
  if (!claim) throw new Error("EXPECTED_MEDIA_SURFACE_JOB");
  const deletionJobId = (claim.payload as { deletionJobId: string }).deletionJobId;
  const request = { ...claimIdentity(claim), deletionJobId, surface: "media" as const };
  const route = new InternalMediaSurfaceRoute(pool, clock, trust, undefined, eraser);
  const response = await route.handle(
    issuer.sign({
      subject: request.workerId,
      audience: "internal.lifecycle.mediaSurface",
      body: request,
      now: clock.now(),
    }).raw,
    request,
  );
  return { response, deletionJobId };
}

const surfaceStatus = async (deletionJobId: string) => Object.fromEntries(
  (await pool.query<{ surface: string; status: string }>(
    "SELECT surface, status FROM deletion_surface_manifest WHERE deletion_job_id = $1",
    [deletionJobId],
  )).rows.map(({ surface, status }) => [surface, status]),
);

beforeAll(async () => runMigrations(lifecycleDatabaseUrl!, "infra/postgres/migrations"));
beforeEach(async () => {
  await resetBusinessTables(lifecycleDatabaseUrl!);
  clock = new MutableClock("2026-08-30T08:00:00.000Z");
});
afterEach(async () => {
  await resetBusinessTables(lifecycleDatabaseUrl!);
  await pool.query("DELETE FROM pilot_retention_policy WHERE policy_version = $1", [RETENTION_POLICY_VERSION]);
});
afterAll(async () => pool.end());

/** A teacher-requested deletion of a room that actually holds media. */
async function requestDeletionOfRoomWithMedia() {
  const room = await seedLifecycleRoom(pool);
  const events = new RoomEventRepository(pool, createCoreEventPayloadRegistry(), clock);
  await new RoomLifecycleService(events, clock).open(room.roomId, room.teacherId, randomUUID());
  const mediaId = await seedRoomMedia(room);
  // One fixed policy, removed again in afterEach. Room creation refuses an
  // ambiguous policy, so a suite that leaves rows behind breaks its neighbours.
  await pool.query(
    `INSERT INTO pilot_retention_policy(policy_id, policy_version, room_events_days, raw_media_days,
       derived_artifacts_days, projections_days, agent_runs_days, provider_copies_days,
       backups_days, audit_metadata_days, approval_reference, approved_at, expires_at)
     VALUES($1,$2,30,14,7,7,7,7,90,365,'test',now(),now() + interval '30 days')
     ON CONFLICT (policy_version) DO NOTHING`,
    [RETENTION_POLICY_ID, RETENTION_POLICY_VERSION],
  );
  await pool.query(
    "UPDATE classroom_room SET retention_policy_id = $2 WHERE room_id = $1",
    [room.roomId, RETENTION_POLICY_ID],
  );
  const governance = new GovernanceService(pool, {
    auditSalt: "deletion-closure-salt",
    clock: () => clock.now(),
  });
  const accepted = await governance.requestDeletion(
    { role: "teacher", teacherId: room.teacherId, actorId: room.teacherId } as never,
    room.roomId,
    { confirmation: `DELETE ${room.roomId}` },
  );
  return { room, mediaId, governance, deletionJobId: accepted.deletionJobId };
}

describe("room deletion closure for a room holding media", () => {
  it("holds the media surface while no eraser can prove the objects are gone", async () => {
    const { deletionJobId, mediaId } = await requestDeletionOfRoomWithMedia();

    const { response } = await runMediaSurfaceJob(undefined);

    expect(response).toMatchObject({ status: "retryable", code: "MEDIA_SURFACE_STORE_UNAVAILABLE" });
    expect((await surfaceStatus(deletionJobId)).media).toBe("frozen");
    // Nothing was removed on the strength of a deletion nobody performed.
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM media_asset WHERE media_id = $1", [mediaId],
    )).rows[0]).toEqual({ count: 1 });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM deletion_receipt WHERE deletion_job_id = $1", [deletionJobId],
    )).rows[0]).toEqual({ count: 0 });
  });

  it("holds it again when the eraser is present but fails", async () => {
    const { deletionJobId } = await requestDeletionOfRoomWithMedia();
    const eraser = new RecordingEraser();
    eraser.fail = true;

    const { response } = await runMediaSurfaceJob(eraser);

    expect(response).toMatchObject({ status: "retryable" });
    expect((await surfaceStatus(deletionJobId)).media).toBe("frozen");
  });

  it("verifies the media surface once its objects are proven gone", async () => {
    const { room, mediaId, deletionJobId } = await requestDeletionOfRoomWithMedia();
    const eraser = new RecordingEraser();

    const { response } = await runMediaSurfaceJob(eraser);

    expect(response).toMatchObject({ status: "completed", surface: "media", verifiedItemCount: 1 });
    expect((await surfaceStatus(deletionJobId)).media).toBe("verified");
    expect(eraser.erased.sort()).toEqual([
      `rooms/${room.roomId}/media/${mediaId}`,
      `rooms/${room.roomId}/media/${mediaId}/thumb`,
    ]);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM media_asset WHERE room_id = $1", [room.roomId],
    )).rows[0]).toEqual({ count: 0 });
    // The receipt still waits for every other surface; one verified surface is
    // not a completed deletion.
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM deletion_receipt WHERE deletion_job_id = $1", [deletionJobId],
    )).rows[0]).toEqual({ count: 0 });
  });

  it("reports a deletion in progress rather than a receipt it does not have", async () => {
    const { room, governance, deletionJobId } = await requestDeletionOfRoomWithMedia();
    const eraser = new RecordingEraser();
    await runMediaSurfaceJob(eraser);

    const status = await governance.deletionStatus(
      { role: "teacher", teacherId: room.teacherId, actorId: room.teacherId } as never,
      deletionJobId,
    );

    expect(status.status).not.toBe("completed");
    expect(status).not.toHaveProperty("receipt");
  });
});
