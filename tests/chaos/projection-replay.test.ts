/**
 * What happens to a claimed job when the worker holding it dies.
 *
 * A job the worker is running is a lease, not a lock, so the interesting
 * failure is not that the worker stops — it is the moment afterwards, when a
 * second worker has taken the job and the first one wakes up and tries to
 * finish. If both are allowed to write, one projection is built twice from two
 * different points, and neither result is trustworthy.
 *
 * These scenarios kill the worker at the worst possible instant and check that
 * the lease, the claim generation and the claim token together make the late
 * write impossible.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabasePool } from "../../apps/server/src/db/pool.js";
import { resetBusinessTables } from "../../apps/server/test/db/reset.js";
import { seedLifecycleRoom } from "../../apps/server/test/rooms/lifecycle-test-fixture.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for chaos tests");

let pool: ReturnType<typeof createDatabasePool>;
let roomId: string;
// analytics jobs claim in room-sequence order, so each fixture needs its own.
let seq = 1;

interface ClaimedJob {
  jobId: string;
  claimGeneration: string;
  claimToken: string;
  lockedBy: string;
}

async function sql(name: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(new URL(`../../apps/server/src/db/sql/${name}`, import.meta.url), "utf8");
  // The canonical files use `$n`; node-postgres does too, so the bytes run as
  // written. The Python worker rewrites them to `%s` for psycopg and hashes
  // the untouched source, which is what makes both runtimes provably equal.
  return text;
}

async function enqueueJob(dedupe: string): Promise<string> {
  const jobId = randomUUID();
  await pool.query(
    `INSERT INTO worker_job(
       job_id, job_type, room_id, dedupe_key, correlation_id, payload,
       status, analytics_order_seq, analytics_order_kind
     ) VALUES($1,'analytics.consume.v1',$2,$3,$4,$5,'queued',$6,0)`,
    [jobId, roomId, `analytics.consume.v1:${dedupe}`, randomUUID(), JSON.stringify({ roomSeq: 1 }), seq++],
  );
  return jobId;
}

/**
 * Claim exactly the way the worker does: the canonical candidate select, then
 * the canonical settle-and-claim. Reimplementing either here would test this
 * file rather than the system.
 */
async function claim(workerId: string): Promise<ClaimedJob | undefined> {
  const candidates = await pool.query<{ job_id: string }>(await sql("claim_worker_job.sql"), [1]);
  const jobIds = candidates.rows.map((row) => row.job_id);
  if (jobIds.length === 0) return undefined;
  const claimed = await pool.query<{
    job_id: string; claim_generation: string; claim_token: string; locked_by: string;
  }>(await sql("settle_worker_job_claims.sql"), [jobIds, jobIds, jobIds, workerId]);
  const row = claimed.rows[0];
  return row && {
    jobId: row.job_id,
    claimGeneration: String(row.claim_generation),
    claimToken: row.claim_token,
    lockedBy: row.locked_by,
  };
}

/** The worker is gone; its lease has not been renewed for longer than allowed. */
async function expireLease(jobId: string): Promise<void> {
  await pool.query(
    "UPDATE worker_job SET locked_at = now() - interval '5 minutes' WHERE job_id=$1",
    [jobId],
  );
}

/** The settle a dead worker would attempt on waking. */
async function settle(job: ClaimedJob): Promise<number> {
  const result = await pool.query(
    `UPDATE worker_job SET status='succeeded', claim_token=NULL, locked_at=NULL,
            locked_by=NULL, updated_at=now()
     WHERE job_id=$1 AND claim_generation=$2::bigint AND claim_token=$3::uuid
       AND locked_by=$4 AND status='running'`,
    [job.jobId, job.claimGeneration, job.claimToken, job.lockedBy],
  );
  return result.rowCount ?? 0;
}

beforeAll(() => { pool = createDatabasePool(databaseUrl); });
afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  await resetBusinessTables(databaseUrl!);
  const room = await seedLifecycleRoom(pool);
  roomId = room.roomId;
  seq = 1;
});

afterEach(async () => { await resetBusinessTables(databaseUrl!); });

describe("projection work under worker loss", () => {
  it("hands a dead worker's job to the next worker, with a new generation", async () => {
    await enqueueJob("handover");
    const first = await claim("worker-that-dies");
    expect(first).toBeDefined();

    // The worker is gone. Nothing settled it, so only the lease says so.
    await expireLease(first!.jobId);

    const second = await claim("worker-that-continues");
    expect(second?.jobId).toBe(first!.jobId);
    expect(second!.lockedBy).toBe("worker-that-continues");
    // The generation is what makes the first worker's claim identifiably old.
    expect(Number(second!.claimGeneration)).toBeGreaterThan(Number(first!.claimGeneration));
    expect(second!.claimToken).not.toBe(first!.claimToken);
  });

  it("refuses the dead worker's late write after the job moved on", async () => {
    await enqueueJob("late-write");
    const first = await claim("worker-that-dies");
    await expireLease(first!.jobId);
    const second = await claim("worker-that-continues");

    // The first worker wakes up and finishes the work it started. Its claim is
    // stale, so the write does nothing: this is the only thing standing
    // between one projection and two conflicting builds of it.
    expect(await settle(first!)).toBe(0);
    expect(await settle(second!)).toBe(1);

    const row = await pool.query<{ status: string; locked_by: string | null }>(
      "SELECT status, locked_by FROM worker_job WHERE job_id=$1", [first!.jobId],
    );
    expect(row.rows[0]?.status).toBe("succeeded");
  });

  it("does not hand out a job whose lease is still alive", async () => {
    await enqueueJob("alive-lease");
    const first = await claim("worker-holding");
    expect(first).toBeDefined();
    // No expiry: a second worker must see nothing, or two workers run one job.
    expect(await claim("worker-stealing")).toBeUndefined();
  });

  it("never hands the same job to two workers at once", async () => {
    await enqueueJob("concurrent");
    const [a, b] = await Promise.all([claim("worker-a"), claim("worker-b")]);
    const claimed = [a, b].filter(Boolean);
    expect(claimed).toHaveLength(1);
  });

  it("leaves a settled job settled when its old worker retries", async () => {
    await enqueueJob("idempotent-settle");
    const job = await claim("worker-1");
    expect(await settle(job!)).toBe(1);
    // A response-loss retry finds the row already terminal and changes
    // nothing, rather than reopening finished work.
    expect(await settle(job!)).toBe(0);
  });
});
