-- Synthetic-only fixture.  Never run this file in a pilot or production
-- environment; it is intentionally not included by the migration runner.
DO $$
BEGIN
  IF current_setting('app.environment', true) <> 'test' THEN
    RAISE EXCEPTION 'SYNTHETIC_POLICY_FIXTURE_FORBIDDEN';
  END IF;
END $$;
INSERT INTO pilot_retention_policy(
  policy_id, policy_version, room_events_days, raw_media_days,
  derived_artifacts_days, projections_days, agent_runs_days,
  provider_copies_days, backups_days, audit_metadata_days,
  approval_reference, approved_at, expires_at
) VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'synthetic-pilot-2026',
  30, 14, 7, 7, 7, 7, 90, 365,
  'synthetic-fixture', now(), now() + interval '365 days'
) ON CONFLICT (policy_version) DO NOTHING;
