SELECT j.job_id
FROM worker_job j
WHERE j.run_after <= now()
  AND (
    (j.status IN ('queued', 'retryable') AND j.claim_token IS NULL
      AND j.locked_at IS NULL AND j.locked_by IS NULL)
    OR (j.status = 'running' AND j.locked_at < now() - interval '2 minutes')
  )
ORDER BY j.run_after, j.created_at
FOR UPDATE SKIP LOCKED
LIMIT $1;
