import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createCoreEventPayloadRegistry,
  mediaInternalOutcomeContract,
  routes,
  type MediaInternalOutcomeRequest,
} from "@learning-orbit/contracts";

import { buildApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { JobStore, claimIdentity, type ClaimedJob } from "../../src/modules/jobs/job-store.js";
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

async function makeApp(): Promise<FastifyInstance> {
  const app = await buildApp({
    pool,
    clock,
    serviceAssertionTrust: trust,
    config: {
      allowedOrigins: ["https://app.learning-orbit.test"],
      publicBaseOrigin: "https://app.learning-orbit.test",
    },
  });
  apps.push(app);
  return app;
}

/** An uploaded image with one claimed media.process.v1 job against it. */
async function seedProcessableMedia(room: SeededLifecycleRoom): Promise<{
  claim: ClaimedJob;
  mediaId: string;
}> {
  await lifecycle.open(room.roomId, room.teacherId, randomUUID());
  const mediaId = randomUUID();
  const correlationId = randomUUID();
  await pool.query(
    `INSERT INTO media_asset(media_id, room_id, owner_actor_id, kind, state,
                             original_file_name, declared_mime, size_bytes,
                             declared_sha256, sha256, alt_text, object_key,
                             promotion_correlation_id)
     SELECT $1,$2,actor_id,'image','uploaded','leaf.png','image/png',2048,$3,$3,'葉片',$4,$5
     FROM room_member WHERE room_member_id = $6`,
    [mediaId, room.roomId, sha("leaf"), `rooms/${room.roomId}/media/${mediaId}`,
      correlationId, room.memberIds[0]],
  );
  await pool.query(
    `INSERT INTO worker_job(job_id, job_type, room_id, source_event_id, dedupe_key,
                            correlation_id, payload, run_after)
     VALUES($1,'media.process.v1',$2,NULL,$3,$4,$5, now())`,
    [randomUUID(), room.roomId, `media.process.v1:${mediaId}`, correlationId, { mediaId }],
  );
  const claims = await new JobStore(pool, "worker-media-1").claim(5);
  const claim = claims.find(({ jobType }) => jobType === "media.process.v1");
  if (!claim) throw new Error("EXPECTED_MEDIA_JOB_CLAIM");
  return { claim, mediaId };
}

function requestFor(
  claim: ClaimedJob,
  mediaId: string,
  overrides: Record<string, unknown> = {},
): MediaInternalOutcomeRequest {
  return {
    ...claimIdentity(claim),
    mediaId,
    transitionId: randomUUID(),
    state: "ready",
    failureCode: null,
    derivatives: [],
    ...overrides,
  } as MediaInternalOutcomeRequest;
}

async function post(app: FastifyInstance, body: MediaInternalOutcomeRequest, assertion?: string) {
  const response = await app.inject({
    method: "POST",
    url: routes.internal.media.outcome(),
    headers: {
      "x-lo-service-assertion": assertion ?? issuer.sign({
        subject: body.workerId,
        audience: "internal.media.outcome",
        body,
        now: clock.now(),
      }).raw,
    },
    payload: body,
  });
  return {
    statusCode: response.statusCode,
    body: mediaInternalOutcomeContract.parseResponse(response.json()),
  };
}

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

describe("signed internal media outcome", () => {
  it("commits a ready outcome with its derivative and closes the claim", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, mediaId } = await seedProcessableMedia(room);
    const app = await makeApp();
    const derivativeId = randomUUID();

    const response = await post(app, requestFor(claim, mediaId, {
      derivatives: [{
        derivativeId,
        kind: "thumbnail",
        objectKey: `rooms/${room.roomId}/media/${mediaId}/thumb`,
        mime: "image/webp",
        sizeBytes: 512,
        sha256: sha("thumb"),
      }],
    }));

    expect(response).toEqual({ statusCode: 200, body: { status: "applied" } });
    expect((await pool.query(
      "SELECT state, failure_code FROM media_asset WHERE media_id = $1", [mediaId],
    )).rows[0]).toEqual({ state: "ready", failure_code: null });
    expect((await pool.query(
      "SELECT kind, mime FROM media_derivative WHERE media_id = $1", [mediaId],
    )).rows).toEqual([{ kind: "thumbnail", mime: "image/webp" }]);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM worker_job_completion WHERE job_id = $1", [claim.jobId],
    )).rows[0]).toEqual({ count: 1 });
  });

  it("carries a quarantine decision and its failure code", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, mediaId } = await seedProcessableMedia(room);
    const app = await makeApp();

    const response = await post(app, requestFor(claim, mediaId, {
      state: "quarantined",
      failureCode: "MALWARE_DETECTED",
    }));

    expect(response.body).toEqual({ status: "applied" });
    expect((await pool.query(
      "SELECT state, failure_code FROM media_asset WHERE media_id = $1", [mediaId],
    )).rows[0]).toEqual({ state: "quarantined", failure_code: "MALWARE_DETECTED" });
  });

  it("treats the same transition as idempotent and a different one as stale", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, mediaId } = await seedProcessableMedia(room);
    const app = await makeApp();
    const request = requestFor(claim, mediaId);

    expect((await post(app, request)).body).toEqual({ status: "applied" });
    expect((await post(app, request)).body).toEqual({ status: "already_applied" });
    expect((await post(app, { ...request, transitionId: randomUUID() })).body)
      .toEqual({ status: "rejected", code: "MEDIA_OUTCOME_INVALID" });
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM media_derivative WHERE media_id = $1", [mediaId],
    )).rows[0]).toEqual({ count: 0 });
  });

  it("refuses a success that carries a failure code and a failure that does not", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, mediaId } = await seedProcessableMedia(room);
    const app = await makeApp();

    for (const overrides of [
      { state: "ready", failureCode: "SOMETHING_WRONG" },
      { state: "failed", failureCode: null },
    ]) {
      expect((await post(app, requestFor(claim, mediaId, overrides))).body)
        .toEqual({ status: "rejected", code: "MEDIA_OUTCOME_INVALID" });
    }
    expect((await pool.query(
      "SELECT state FROM media_asset WHERE media_id = $1", [mediaId],
    )).rows[0]).toEqual({ state: "uploaded" });
  });

  it("writes nothing for a superseded claim", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, mediaId } = await seedProcessableMedia(room);
    const app = await makeApp();
    await pool.query(
      `UPDATE worker_job SET claim_generation = claim_generation + 1, claim_token = $2
       WHERE job_id = $1`,
      [claim.jobId, randomUUID()],
    );

    expect(await post(app, requestFor(claim, mediaId))).toEqual({
      statusCode: 409,
      body: { status: "rejected", code: "JOB_CLAIM_STALE" },
    });
    expect((await pool.query(
      "SELECT state FROM media_asset WHERE media_id = $1", [mediaId],
    )).rows[0]).toEqual({ state: "uploaded" });
  });

  it("rejects an unsigned request before it reaches the generated parser", async () => {
    const room = await seedLifecycleRoom(pool);
    const { claim, mediaId } = await seedProcessableMedia(room);
    const app = await makeApp();

    // Structurally invalid *and* unsigned: the assertion failure must win, or
    // an unauthenticated caller could use the parser as a schema oracle.
    const response = await post(
      app,
      { ...requestFor(claim, mediaId), state: "nonsense" } as never,
      "not-a-signature",
    );

    expect(response).toEqual({
      statusCode: 401,
      body: { status: "rejected", code: "SERVICE_ASSERTION_INVALID" },
    });
  });
});
