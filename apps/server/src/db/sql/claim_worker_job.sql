SELECT j.job_id
FROM worker_job j
WHERE j.run_after <= now()
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
ORDER BY j.run_after, j.created_at
FOR UPDATE SKIP LOCKED
LIMIT $1;
