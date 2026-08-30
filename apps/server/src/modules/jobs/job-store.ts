import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";

import { inTransaction } from "../../db/transactions.js";
import type { JobClaimIdentity } from "./job-claim-authority.js";

const sqlDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../db/sql");
const claimWorkerJobSql = readFileSync(resolve(sqlDirectory, "claim_worker_job.sql"), "utf8");
const settleWorkerJobClaimsSql = readFileSync(resolve(sqlDirectory, "settle_worker_job_claims.sql"), "utf8");

type WorkerJobRow = {
  job_id: string;
  job_type: string;
  room_id: string | null;
  source_event_id: string | null;
  dedupe_key: string;
  correlation_id: string;
  payload: unknown;
  attempts: number;
  claim_generation: string;
  claim_token: string;
  locked_by: string;
  analytics_order_seq: string | number | null;
  analytics_order_kind: number | null;
};

export type ClaimedJob = Readonly<{
  jobId: string;
  jobType: string;
  roomId: string | null;
  sourceEventId: string | null;
  dedupeKey: string;
  correlationId: string;
  payload: unknown;
  attempts: number;
  claimGeneration: string;
  claimToken: string;
  workerId: string;
  analyticsOrderSeq: number | null;
  analyticsOrderKind: number | null;
}>;

function toClaimedJob(row: WorkerJobRow): ClaimedJob {
  if (!row.claim_token || !row.locked_by) throw new Error("WORKER_JOB_CLAIM_INVARIANT");
  const orderSeq = row.analytics_order_seq === null ? null : Number(row.analytics_order_seq);
  const orderKind = row.analytics_order_kind === null ? null : Number(row.analytics_order_kind);
  if ((orderSeq === null) !== (orderKind === null)
    || (orderSeq !== null && (!Number.isSafeInteger(orderSeq) || orderSeq < 0))
    || (orderKind !== null && (!Number.isSafeInteger(orderKind) || ![0, 1].includes(orderKind)))) {
    throw new Error("WORKER_JOB_ANALYTICS_ORDER_INVARIANT");
  }
  if (row.job_type === "analytics.consume.v1" && (orderSeq === null || orderKind !== 0 || orderSeq < 1)) {
    throw new Error("WORKER_JOB_ANALYTICS_ORDER_INVARIANT");
  }
  if (row.job_type === "analytics.replay-room.v1" && (orderSeq === null || orderKind !== 1)) {
    throw new Error("WORKER_JOB_ANALYTICS_ORDER_INVARIANT");
  }
  if (row.job_type !== "analytics.consume.v1" && row.job_type !== "analytics.replay-room.v1"
    && (orderSeq !== null || orderKind !== null)) {
    throw new Error("WORKER_JOB_ANALYTICS_ORDER_INVARIANT");
  }
  return {
    jobId: row.job_id,
    jobType: row.job_type,
    roomId: row.room_id,
    sourceEventId: row.source_event_id,
    dedupeKey: row.dedupe_key,
    correlationId: row.correlation_id,
    payload: row.payload,
    attempts: row.attempts,
    claimGeneration: row.claim_generation,
    claimToken: row.claim_token,
    workerId: row.locked_by,
    analyticsOrderSeq: orderSeq,
    analyticsOrderKind: orderKind,
  };
}

export function claimIdentity(job: ClaimedJob): JobClaimIdentity {
  const {
    payload: _payload,
    attempts: _attempts,
    analyticsOrderSeq: _analyticsOrderSeq,
    analyticsOrderKind: _analyticsOrderKind,
    ...identity
  } = job;
  return identity;
}

export class JobStore {
  constructor(
    private readonly pool: Pool,
    private readonly workerId: string,
  ) {}

  async claim(limit = 1): Promise<ClaimedJob[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("WORKER_CLAIM_LIMIT_INVALID");
    return inTransaction(this.pool, async (tx: PoolClient) => {
      const candidates = await tx.query<{ job_id: string }>(claimWorkerJobSql, [limit]);
      const jobIds = candidates.rows.map((row) => row.job_id);
      if (jobIds.length === 0) return [];
      const settled = await tx.query<WorkerJobRow>(settleWorkerJobClaimsSql, [jobIds, jobIds, jobIds, this.workerId]);
      return settled.rows.map(toClaimedJob);
    });
  }
}
