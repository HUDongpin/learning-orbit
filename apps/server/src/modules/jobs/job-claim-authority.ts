import type { PoolClient } from "pg";

export type JobClaimIdentity = Readonly<{
  jobId: string;
  jobType: string;
  roomId: string | null;
  sourceEventId: string | null;
  dedupeKey: string;
  correlationId: string;
  claimGeneration: string;
  claimToken: string;
  workerId: string;
}>;

export class JobClaimAuthority {
  async requireCurrent(tx: PoolClient, claim: JobClaimIdentity): Promise<void> {
    const result = await tx.query(
      `SELECT 1 FROM worker_job WHERE job_id = $1 AND job_type = $2
       AND room_id IS NOT DISTINCT FROM $3::uuid
       AND source_event_id IS NOT DISTINCT FROM $4::uuid
       AND dedupe_key = $5 AND correlation_id = $6::uuid
       AND claim_generation = $7::bigint AND claim_token = $8::uuid
       AND locked_by = $9 AND status = 'running' FOR UPDATE`,
      [
        claim.jobId,
        claim.jobType,
        claim.roomId,
        claim.sourceEventId,
        claim.dedupeKey,
        claim.correlationId,
        claim.claimGeneration,
        claim.claimToken,
        claim.workerId,
      ],
    );
    if (result.rowCount !== 1) throw new Error("JOB_CLAIM_STALE");
  }

  async completeBusiness(tx: PoolClient, claim: JobClaimIdentity, completionCode: string): Promise<void> {
    if (!/^[A-Z0-9_]{1,64}$/.test(completionCode)) throw new Error("JOB_COMPLETION_CODE_INVALID");
    await this.requireCurrent(tx, claim);
    await tx.query(
      `INSERT INTO worker_job_completion(job_id, claim_generation, claim_token_hash, completion_code)
       VALUES ($1, $2::bigint, encode(digest($3::text, 'sha256'), 'hex'), $4)
       ON CONFLICT (job_id, claim_generation) DO NOTHING`,
      [claim.jobId, claim.claimGeneration, claim.claimToken, completionCode],
    );
    const marker = await tx.query<{ claim_token_hash: string; completion_code: string }>(
      `SELECT claim_token_hash, completion_code FROM worker_job_completion
       WHERE job_id = $1 AND claim_generation = $2::bigint FOR UPDATE`,
      [claim.jobId, claim.claimGeneration],
    );
    const expected = await tx.query<{ token_hash: string }>(
      "SELECT encode(digest($1::text, 'sha256'), 'hex') AS token_hash",
      [claim.claimToken],
    );
    if (
      marker.rowCount !== 1
      || marker.rows[0]?.claim_token_hash !== expected.rows[0]?.token_hash
      || marker.rows[0]?.completion_code !== completionCode
    ) {
      throw new Error("JOB_COMPLETION_CONFLICT");
    }
  }
}
