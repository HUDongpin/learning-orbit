import { execFile } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCoreEventPayloadRegistry } from "@learning-orbit/contracts";

import { buildApp } from "../../src/app.js";
import { runMigrations } from "../../src/db/migrate.js";
import { RoomEventRepository } from "../../src/modules/rooms/room-event-repository.js";
import { RoomLifecycleService } from "../../src/modules/rooms/lifecycle-service.js";
import { createServiceAssertionTrust } from "../../src/modules/security/service-assertion.js";
import { resetBusinessTables } from "../db/reset.js";
import {
  lifecycleDatabaseUrl,
  MutableClock,
  seedLifecycleRoom,
} from "./lifecycle-test-fixture.js";

const execFileAsync = promisify(execFile);
const REPOSITORY = resolve(import.meta.dirname, "../../../..");
const WORKER_PYTHON = join(REPOSITORY, ".venv/bin/python");
const ISSUER = "learning-orbit-restart-proof";
const KEY_ID = "restart-proof-key-1";

const pool = new Pool({ connectionString: lifecycleDatabaseUrl, max: 8 });
const apps: FastifyInstance[] = [];
const temporaries: string[] = [];
interface WorkerMaterial {
  readonly directory: string;
  readonly privateKeyPath: string;
  readonly publicKeyPem: string;
}

/**
 * A key pair that exists only for this test: written 0600, never packaged, and
 * discarded with its directory. The worker refuses a key supplied any other
 * way, which is exactly what makes this a proof rather than a simulation.
 */
async function issueWorkerKey(): Promise<WorkerMaterial> {
  const directory = await mkdtemp(join(tmpdir(), "lo-restart-proof-"));
  temporaries.push(directory);
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPath = join(directory, "worker-assertion-private.pem");
  await writeFile(privateKeyPath, pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), { mode: 0o600 });
  await chmod(privateKeyPath, 0o600);
  return {
    directory,
    privateKeyPath,
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

async function listeningApp(trustedPublicKeyPem: string): Promise<{ app: FastifyInstance; origin: string }> {
  // Deliberately the system clock. The worker signs its assertion with real
  // time, and the assertion's freshness window is seconds wide, so an app on a
  // fake clock would reject every real signature as stale. Only the room's
  // deadline is moved into the past.
  const app = await buildApp({
    pool,
    serviceAssertionTrust: createServiceAssertionTrust({
      version: 1,
      keys: [{ issuer: ISSUER, keyId: KEY_ID, publicKeyPem: trustedPublicKeyPem }],
    }),
    config: {
      allowedOrigins: ["https://app.learning-orbit.test"],
      publicBaseOrigin: "https://app.learning-orbit.test",
    },
  });
  apps.push(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("TEST_LISTENER_UNAVAILABLE");
  return { app, origin: `http://127.0.0.1:${address.port}` };
}

/** Run the real worker process for exactly one claim. */
async function runWorkerOnce(material: WorkerMaterial, origin: string) {
  return execFileAsync(WORKER_PYTHON, ["-m", "learning_orbit_worker.main", "--once"], {
    cwd: REPOSITORY,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      // The worker is imported from the checkout, not from site-packages. The
      // pilot harness builds its venv from requirements.lock alone, so the
      // package is only importable at a workstation where someone installed it
      // editable - which is why this passed locally and failed the gate.
      PYTHONPATH: join(REPOSITORY, "services/worker/src"),
      DATABASE_URL: lifecycleDatabaseUrl!,
      LO_WORKER_ID: "restart-proof-worker",
      LO_WORKER_ASSERTION_PRIVATE_KEY_FILE: material.privateKeyPath,
      LO_SERVICE_ASSERTION_ISSUER: ISSUER,
      LO_SERVICE_ASSERTION_KEY_ID: KEY_ID,
      LO_INTERNAL_BASE_ORIGIN: origin,
      LO_ANALYTICS_PSEUDONYM_KEY: Buffer.alloc(32, 5).toString("base64url"),
      LO_WORKER_POLL_SECONDS: "0.25",
      LO_WORKER_CLAIM_SIZE: "1",
    },
  });
}

const roomStatus = async (roomId: string) => (await pool.query<{ status: string }>(
  "SELECT status FROM classroom_room WHERE room_id = $1", [roomId],
)).rows[0]?.status;

const closedEvents = async (roomId: string) => Number((await pool.query<{ count: string }>(
  "SELECT count(*)::text AS count FROM room_event WHERE room_id = $1 AND type = 'room.closed'",
  [roomId],
)).rows[0]!.count);

const liveStudentSessions = async (roomId: string) => Number((await pool.query<{ count: string }>(
  `SELECT count(*)::text AS count FROM auth_session s
   JOIN room_member m ON m.room_member_id = s.room_member_id
   WHERE m.room_id = $1 AND s.revoked_at IS NULL`,
  [roomId],
)).rows[0]!.count);

beforeAll(async () => runMigrations(lifecycleDatabaseUrl!, "infra/postgres/migrations"));
beforeEach(async () => {
  await resetBusinessTables(lifecycleDatabaseUrl!);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  await resetBusinessTables(lifecycleDatabaseUrl!);
});
afterAll(async () => pool.end());

/**
 * Open a room whose 45 minutes have already elapsed in real time.
 *
 * The room is opened on a clock set 46 minutes ago, so its closesAt - and the
 * auto-close job's run_after, which must equal it - are both a minute in the
 * past. Everything else runs on the real clock.
 */
async function openRoomPastItsDeadline(minutesAgo = 46) {
  const room = await seedLifecycleRoom(pool);
  const opened = new MutableClock(new Date(Date.now() - minutesAgo * 60_000).toISOString());
  const lifecycle = new RoomLifecycleService(
    new RoomEventRepository(pool, createCoreEventPayloadRegistry(), opened),
    opened,
  );
  await lifecycle.open(room.roomId, room.teacherId, randomUUID());
  return room;
}

describe("real worker closes a room across a restart", () => {
  it("closes once through the signed internal route", async () => {
    const room = await openRoomPastItsDeadline();
    const material = await issueWorkerKey();
    const { origin } = await listeningApp(material.publicKeyPem);
    expect(await liveStudentSessions(room.roomId)).toBeGreaterThan(0);

    await runWorkerOnce(material, origin);

    expect(await roomStatus(room.roomId)).toBe("closed");
    expect(await closedEvents(room.roomId)).toBe(1);
    expect((await pool.query(
      "SELECT status FROM worker_job WHERE job_type = 'room.auto-close.v1'",
    )).rows[0]).toEqual({ status: "succeeded" });
    // Seat sessions deliberately survive a close: the socket authorizer stops
    // durable frames on a closed room while the student keeps a session that
    // can still receive permission changes. Only deletion revokes.
    expect(await liveStudentSessions(room.roomId)).toBeGreaterThan(0);
  }, 120_000);

  it("closes exactly once when the worker is restarted after the deadline", async () => {
    const room = await openRoomPastItsDeadline();
    const material = await issueWorkerKey();
    const { origin } = await listeningApp(material.publicKeyPem);

    // Two separate worker processes across the same deadline: the second finds
    // the job already terminal and must not close the room a second time.
    await runWorkerOnce(material, origin);
    await runWorkerOnce(material, origin);

    expect(await roomStatus(room.roomId)).toBe("closed");
    expect(await closedEvents(room.roomId)).toBe(1);
  }, 120_000);

  it("writes nothing at all when the worker's key is not the trusted one", async () => {
    const room = await openRoomPastItsDeadline();
    const trusted = await issueWorkerKey();
    const tampered = await issueWorkerKey();
    // The server trusts one key; the worker signs with another.
    const { origin } = await listeningApp(trusted.publicKeyPem);

    await runWorkerOnce(tampered, origin);

    expect(await roomStatus(room.roomId)).toBe("open");
    expect(await closedEvents(room.roomId)).toBe(0);
    expect(await liveStudentSessions(room.roomId)).toBeGreaterThan(0);
    // The job records its own failure and nothing else is written: no close,
    // no completion receipt, no partially applied transition.
    const job = (await pool.query<{ status: string }>(
      "SELECT status FROM worker_job WHERE job_type = 'room.auto-close.v1'",
    )).rows[0];
    expect(["retryable", "dead"]).toContain(job!.status);
    expect((await pool.query(
      "SELECT count(*)::int AS count FROM worker_job_completion",
    )).rows[0]).toEqual({ count: 0 });
  }, 120_000);

  it("leaves a room whose deadline has not arrived untouched", async () => {
    // Opened one minute ago, so its deadline is still 44 minutes away.
    const room = await openRoomPastItsDeadline(1);
    // The job is made claimable anyway; the route must still refuse to close.
    await pool.query("UPDATE worker_job SET run_after = now() WHERE job_type = 'room.auto-close.v1'");
    const material = await issueWorkerKey();
    const { origin } = await listeningApp(material.publicKeyPem);

    await runWorkerOnce(material, origin).catch(() => undefined);

    expect(await roomStatus(room.roomId)).toBe("open");
    expect(await closedEvents(room.roomId)).toBe(0);
  }, 120_000);
});
