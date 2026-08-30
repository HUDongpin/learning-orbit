WITH recovered AS (
  UPDATE worker_job j
  SET status = 'succeeded', claim_token = NULL, locked_at = NULL, locked_by = NULL,
      last_error = NULL, updated_at = now()
  FROM worker_job_completion c
  WHERE j.job_id = c.job_id AND j.status = 'running'
    AND j.job_id = ANY($1::uuid[])
    AND c.claim_generation = j.claim_generation
    AND c.claim_token_hash = encode(digest(j.claim_token::text, 'sha256'), 'hex')
    AND j.locked_at < now() - interval '2 minutes'
  RETURNING j.job_id
), recovered_completion_cleanup AS (
  DELETE FROM worker_job_completion c
  USING recovered r
  WHERE c.job_id = r.job_id
  RETURNING c.job_id
), exhausted AS (
  UPDATE worker_job j
  SET status = 'dead', claim_token = NULL, locked_at = NULL, locked_by = NULL,
      last_error = 'JOB_LEASE_EXPIRED_MAX_ATTEMPTS', updated_at = now()
  WHERE j.job_id = ANY($2::uuid[]) AND j.status = 'running'
    AND j.locked_at < now() - interval '2 minutes'
    AND j.attempts >= j.max_attempts
    AND j.job_id NOT IN (SELECT job_id FROM recovered)
  RETURNING j.job_id
), lifecycle_dead AS (
  UPDATE deletion_job d
  SET status = CASE WHEN d.status IN ('completed','dead') THEN d.status ELSE 'dead' END
  FROM exhausted e
  JOIN worker_job j ON j.job_id = e.job_id
  WHERE j.job_type = 'room.delete-surface.v1'
    AND d.deletion_job_id::text = j.payload->>'deletionJobId'
  RETURNING d.deletion_job_id
), picked AS (
  SELECT j.job_id
  FROM worker_job j
  WHERE j.job_id = ANY($3::uuid[]) AND j.attempts < j.max_attempts
    AND j.job_id NOT IN (SELECT job_id FROM recovered)
    AND j.job_id NOT IN (SELECT job_id FROM exhausted)
    AND (
      (j.status IN ('queued', 'retryable') AND j.claim_token IS NULL
        AND j.locked_at IS NULL AND j.locked_by IS NULL)
      OR (j.status = 'running' AND j.locked_at < now() - interval '2 minutes')
    )
    AND NOT EXISTS (
      SELECT 1
      FROM worker_job prior
      WHERE j.job_type IN ('analytics.consume.v1', 'analytics.replay-room.v1')
        AND prior.job_type IN ('analytics.consume.v1', 'analytics.replay-room.v1')
        AND prior.room_id = j.room_id
        AND (prior.analytics_order_seq, prior.analytics_order_kind, prior.job_id)
            < (j.analytics_order_seq, j.analytics_order_kind, j.job_id)
        AND prior.status <> 'succeeded'
    )
)
UPDATE worker_job j
SET status = 'running', locked_at = now(), locked_by = $4,
    claim_token = gen_random_uuid(), claim_generation = j.claim_generation + 1,
    attempts = j.attempts + 1, updated_at = now()
FROM picked
WHERE j.job_id = picked.job_id
RETURNING j.*;
