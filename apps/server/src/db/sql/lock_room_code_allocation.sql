SELECT pg_advisory_xact_lock(
  hashtextextended(
    'learning-orbit-room-code-allocation-v1:' || upper(btrim($1::text)),
    0
  )
);
