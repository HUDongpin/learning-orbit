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
)
UPDATE worker_job j
SET status = 'running', locked_at = now(), locked_by = $4,
    claim_token = gen_random_uuid(), claim_generation = j.claim_generation + 1,
    attempts = j.attempts + 1, updated_at = now()
FROM picked
WHERE j.job_id = picked.job_id
RETURNING j.*;
