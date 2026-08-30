-- Snapshot warnings are part of the generated public projection contract.
-- Persist them separately from the analytical payload so retries can prove
-- that the immutable metadata is byte-equivalent instead of fabricating [].
ALTER TABLE analysis_projection_snapshots
  ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN warnings_sha256 char(64) NOT NULL
    DEFAULT '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  ADD CONSTRAINT analysis_projection_snapshot_warnings_array_ck
    CHECK (jsonb_typeof(warnings) = 'array'),
  ADD CONSTRAINT analysis_projection_snapshot_warnings_sha_ck
    CHECK (warnings_sha256 ~ '^[a-f0-9]{64}$');

-- New writers must always provide both values. The defaults above exist only
-- to backfill rows created by migrations 003-009 during this migration.
ALTER TABLE analysis_projection_snapshots
  ALTER COLUMN warnings DROP DEFAULT,
  ALTER COLUMN warnings_sha256 DROP DEFAULT;
