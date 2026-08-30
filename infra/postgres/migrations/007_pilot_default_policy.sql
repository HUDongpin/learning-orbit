-- Test-only bootstrap.  Production and pilot deployments must provision an
-- approved policy out of band and let RoomService resolve it explicitly.
-- An empty/unknown migration environment intentionally performs no write, so
-- the NOT VALID constraint in 006 remains fail-closed for new rooms.
DO $$
DECLARE
  migration_env text := current_setting('learning_orbit.migration_env', true);
BEGIN
  IF migration_env = 'test' THEN
    INSERT INTO pilot_retention_policy(
      policy_id, policy_version, room_events_days, raw_media_days,
      derived_artifacts_days, projections_days, agent_runs_days,
      provider_copies_days, backups_days, audit_metadata_days,
      approval_reference, approved_at, expires_at
    ) VALUES (
      '00000000-0000-4000-8000-000000000705', 'pilot-default-v1',
      30, 14, 7, 7, 7, 7, 90, 365,
      'learning-orbit-test-fixture', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'
    ) ON CONFLICT (policy_id) DO NOTHING;

    ALTER TABLE classroom_room
      ALTER COLUMN retention_policy_id
      SET DEFAULT '00000000-0000-4000-8000-000000000705';
  ELSE
    -- If a database was previously bootstrapped with the test fixture, remove
    -- only the column default when it is opened in a production-like
    -- environment.  The immutable policy row is left untouched for an
    -- explicit operator migration; silently deleting governance records would
    -- be more dangerous than retaining an inert audit row.
    ALTER TABLE classroom_room
      ALTER COLUMN retention_policy_id
      DROP DEFAULT;
    RAISE NOTICE 'Learning Orbit pilot policy bootstrap skipped (migration_env=%)', COALESCE(migration_env, '<unset>');
  END IF;
END $$;
