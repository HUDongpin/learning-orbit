WITH candidates AS (
  SELECT o.outbox_id
  FROM outbox_event o
  WHERE o.published_at IS NULL
    AND o.available_at <= now()
    AND (o.locked_at IS NULL OR o.locked_at < now() - interval '2 minutes')
  ORDER BY o.available_at, o.created_at, o.outbox_id
  FOR UPDATE SKIP LOCKED
  LIMIT $1
)
UPDATE outbox_event o
SET locked_at = now(), locked_by = $2, publish_attempts = o.publish_attempts + 1
FROM candidates c
WHERE o.outbox_id = c.outbox_id
RETURNING o.*;
