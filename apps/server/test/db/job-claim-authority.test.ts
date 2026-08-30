import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../src/db/migrate.js";
import { JobClaimAuthority } from "../../src/modules/jobs/job-claim-authority.js";
import { JobStore, type ClaimedJob, claimIdentity } from "../../src/modules/jobs/job-store.js";
import { lockRoomInTransaction } from "../../src/modules/rooms/room-lock.js";
import { resetBusinessTables } from "./reset.js";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required for database integration tests");

const pool = new Pool({ connectionString: url, max: 10 });
const authority = new JobClaimAuthority();
const sqlDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/db/sql");
const claimWorkerJobSql = readFileSync(resolve(sqlDirectory, "claim_worker_job.sql"), "utf8");
const settleWorkerJobClaimsSql = readFileSync(resolve(sqlDirectory, "settle_worker_job_claims.sql"), "utf8");

async function seedAndClaim(workerId = "worker-a"): Promise<ClaimedJob> {
  await pool.query(
    "INSERT INTO worker_job(job_type, dedupe_key, payload) VALUES($1, $2, '{}')",
    ["schema.probe.v1", `job:${randomUUID()}`],
  );
  const claims = await new JobStore(pool, workerId).claim(1);
  expect(claims).toHaveLength(1);
  return claims[0]!;
}

async function transaction<T>(work: (client: Awaited<ReturnType<typeof pool.connect>>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function waitForLock(pid: number): Promise<void> {
  for (let attempts = 0; attempts < 30; attempts += 1) {
    const wait = await pool.query<{ wait_event_type: string | null }>(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (wait.rows[0]?.wait_event_type === "Lock") return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("BUSINESS_TRANSACTION_DID_NOT_BLOCK_ON_WORKER_ROW");
}

async function seedRoomBoundClaim(workerId = "worker-a"): Promise<ClaimedJob> {
  const teacherId = randomUUID();
  const roomId = randomUUID();
  await pool.query("INSERT INTO teacher_account(teacher_id, email) VALUES($1, $2)", [teacherId, `teacher-${randomUUID()}@example.test`]);
  await pool.query(
    `INSERT INTO classroom_room(room_id, room_code_hash, nova_actor_id, teacher_id, topic)
     VALUES($1, decode($2, 'hex'), $3, $4, 'room-lock protocol')`,
    [roomId, randomUUID().replaceAll("-", ""), randomUUID(), teacherId],
  );
  await pool.query(
    "INSERT INTO worker_job(job_type, room_id, dedupe_key, payload) VALUES($1, $2, $3, '{}')",
    ["room.auto-close.v1", roomId, `room-job:${randomUUID()}`],
  );
  const claims = await new JobStore(pool, workerId).claim(1);
  expect(claims).toHaveLength(1);
  return claims[0]!;
}

beforeAll(async () => runMigrations(url, "infra/postgres/migrations"));
beforeEach(async () => {
  await resetBusinessTables(url);
});
afterEach(async () => resetBusinessTables(url));
afterAll(async () => pool.end());

describe("JobClaimAuthority", () => {
  it("locks the exact running tuple and fences every altered field", async () => {
    const claimed = await seedAndClaim();
    await transaction((tx) => authority.requireCurrent(tx, claimIdentity(claimed)));
    const altered = [
      { jobId: randomUUID() },
      { jobType: "other.v1" },
      { roomId: randomUUID() },
      { sourceEventId: randomUUID() },
      { dedupeKey: `other:${randomUUID()}` },
      { correlationId: randomUUID() },
      { claimGeneration: "999" },
      { claimToken: randomUUID() },
      { workerId: "worker-b" },
    ];
    for (const changed of altered) {
      await expect(transaction((tx) => authority.requireCurrent(tx, { ...claimIdentity(claimed), ...changed })))
        .rejects.toThrow("JOB_CLAIM_STALE");
    }
  });

  it("accepts one stable marker, preserves pg bigint strings, and rejects conflicts", async () => {
    const claimed = await seedAndClaim();
    expect(claimed.claimGeneration).toBe("1");
    await transaction(async (tx) => {
      await authority.completeBusiness(tx, claimIdentity(claimed), "PROBE_COMPLETED");
      await authority.completeBusiness(tx, claimIdentity(claimed), "PROBE_COMPLETED");
    });
    const marker = await pool.query(
      "SELECT claim_generation, completion_code FROM worker_job_completion WHERE job_id = $1",
      [claimed.jobId],
    );
    expect(marker.rows).toEqual([{ claim_generation: "1", completion_code: "PROBE_COMPLETED" }]);
    await expect(transaction((tx) => authority.completeBusiness(tx, claimIdentity(claimed), "OTHER_COMPLETION")))
      .rejects.toThrow("JOB_COMPLETION_CONFLICT");
    await expect(transaction((tx) => authority.completeBusiness(tx, claimIdentity(claimed), "not-valid")))
      .rejects.toThrow("JOB_COMPLETION_CODE_INVALID");
  });

  it("reclaims with a new generation and fences stale business writes", async () => {
    const first = await seedAndClaim("worker-a");
    await pool.query("UPDATE worker_job SET locked_at = now() - interval '3 minutes' WHERE job_id = $1", [first.jobId]);
    const second = (await new JobStore(pool, "worker-b").claim(1))[0]!;
    expect(second.claimGeneration).toBe("2");
    expect(second.claimToken).not.toBe(first.claimToken);
    await expect(transaction((tx) => authority.completeBusiness(tx, claimIdentity(first), "PROBE_COMPLETED")))
      .rejects.toThrow("JOB_CLAIM_STALE");
  });

  it("recovers an expired marked job to succeeded before max-attempt death", async () => {
    const claim = await seedAndClaim();
    await transaction((tx) => authority.completeBusiness(tx, claimIdentity(claim), "PROBE_COMPLETED"));
    await pool.query(
      "UPDATE worker_job SET locked_at = now() - interval '3 minutes', attempts = max_attempts WHERE job_id = $1",
      [claim.jobId],
    );
    expect(await new JobStore(pool, "worker-b").claim(1)).toEqual([]);
    const job = await pool.query("SELECT status FROM worker_job WHERE job_id = $1", [claim.jobId]);
    expect(job.rows[0]).toEqual({ status: "succeeded" });
    const markers = await pool.query("SELECT 1 FROM worker_job_completion WHERE job_id = $1", [claim.jobId]);
    expect(markers.rowCount).toBe(0);
  });

  it("uses the global business-first order without deadlock and makes candidates skip the locked job", async () => {
    const claim = await seedRoomBoundClaim();
    await pool.query("UPDATE worker_job SET locked_at = now() - interval '3 minutes' WHERE job_id = $1", [claim.jobId]);
    const business = await pool.connect();
    try {
      await business.query("BEGIN");
      await lockRoomInTransaction(business, claim.roomId!);
      await business.query("SELECT 1 FROM classroom_room WHERE room_id = $1 FOR UPDATE", [claim.roomId]);
      await authority.completeBusiness(business, claimIdentity(claim), "PROBE_COMPLETED");
      // The business transaction owns the exact worker row; SKIP LOCKED must not
      // reclaim it while its durable marker is still uncommitted.
      expect(await new JobStore(pool, "worker-b").claim(1)).toEqual([]);
      await business.query("COMMIT");
    } catch (error) {
      await business.query("ROLLBACK");
      throw error;
    } finally {
      business.release();
    }
    // The later candidate transaction sees the committed marker and settles to
    // succeeded, not a fresh running claim or an exhausted dead job.
    expect(await new JobStore(pool, "worker-b").claim(1)).toEqual([]);
    const job = await pool.query("SELECT status FROM worker_job WHERE job_id = $1", [claim.jobId]);
    expect(job.rows[0]).toEqual({ status: "succeeded" });
  });

  it("fences a business transaction when the actual candidate and settle SQL win first", async () => {
    const oldClaim = await seedRoomBoundClaim("worker-a");
    await pool.query("UPDATE worker_job SET locked_at = now() - interval '3 minutes' WHERE job_id = $1", [oldClaim.jobId]);
    const candidate = await pool.connect();
    const business = await pool.connect();
    let candidateOpen = false;
    let businessOpen = false;
    try {
      await candidate.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      candidateOpen = true;
      const candidates = await candidate.query<{ job_id: string }>(claimWorkerJobSql, [1]);
      const lockedIds = candidates.rows.map((row) => row.job_id);
      expect(lockedIds).toEqual([oldClaim.jobId]);

      const businessPid = (await business.query<{ pg_backend_pid: number }>("SELECT pg_backend_pid()"))
        .rows[0]?.pg_backend_pid;
      expect(businessPid).toBeTypeOf("number");
      await business.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      businessOpen = true;
      await lockRoomInTransaction(business, oldClaim.roomId!);
      await business.query("SELECT 1 FROM classroom_room WHERE room_id = $1 FOR UPDATE", [oldClaim.roomId]);
      const staleBusiness = authority.completeBusiness(business, claimIdentity(oldClaim), "ROOM_AUTO_CLOSE_COMPLETED");
      await waitForLock(businessPid!);

      const settled = await candidate.query(settleWorkerJobClaimsSql, [lockedIds, lockedIds, lockedIds, "worker-b"]);
      expect(settled.rowCount).toBe(1);
      await candidate.query("COMMIT");
      candidateOpen = false;

      await expect(staleBusiness).rejects.toThrow("JOB_CLAIM_STALE");
      await business.query("ROLLBACK");
      businessOpen = false;
      const row = await pool.query(
        "SELECT status, claim_generation, claim_token, locked_by FROM worker_job WHERE job_id = $1",
        [oldClaim.jobId],
      );
      expect(row.rows[0]).toMatchObject({ status: "running", claim_generation: "2", locked_by: "worker-b" });
      expect(row.rows[0]?.claim_token).not.toBe(oldClaim.claimToken);
      const marker = await pool.query("SELECT 1 FROM worker_job_completion WHERE job_id = $1", [oldClaim.jobId]);
      expect(marker.rowCount).toBe(0);
    } finally {
      if (candidateOpen) await candidate.query("ROLLBACK");
      if (businessOpen) await business.query("ROLLBACK");
      candidate.release();
      business.release();
    }
  });

  it("marks an expired exhausted unmarked job dead", async () => {
    const claim = await seedAndClaim();
    await pool.query(
      "UPDATE worker_job SET locked_at = now() - interval '3 minutes', attempts = max_attempts WHERE job_id = $1",
      [claim.jobId],
    );
    expect(await new JobStore(pool, "worker-b").claim(1)).toEqual([]);
    const job = await pool.query("SELECT status, last_error FROM worker_job WHERE job_id = $1", [claim.jobId]);
    expect(job.rows[0]).toEqual({ status: "dead", last_error: "JOB_LEASE_EXPIRED_MAX_ATTEMPTS" });
  });
});
