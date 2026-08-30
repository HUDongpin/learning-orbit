-- Pilot governance is deliberately content-free.  All identifiers are either
-- opaque references or salted hashes; learner content never belongs in these
-- tables.  Every statement is safe to replay.
CREATE TABLE IF NOT EXISTS pilot_retention_policy (
  policy_id uuid PRIMARY KEY,
  policy_version text UNIQUE NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 160),
  room_events_days integer NOT NULL CHECK (room_events_days > 0),
  raw_media_days integer NOT NULL CHECK (raw_media_days > 0),
  derived_artifacts_days integer NOT NULL CHECK (derived_artifacts_days > 0),
  projections_days integer NOT NULL CHECK (projections_days > 0),
  agent_runs_days integer NOT NULL CHECK (agent_runs_days > 0),
  provider_copies_days integer NOT NULL CHECK (provider_copies_days > 0),
  backups_days integer NOT NULL CHECK (backups_days > 0),
  audit_metadata_days integer NOT NULL CHECK (audit_metadata_days > 0),
  approval_reference text NOT NULL CHECK (char_length(approval_reference) BETWEEN 1 AND 160),
  approved_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > approved_at),
  CHECK (room_events_days >= GREATEST(derived_artifacts_days, projections_days, agent_runs_days)),
  CHECK (raw_media_days >= derived_artifacts_days),
  CHECK (provider_copies_days <= LEAST(raw_media_days, derived_artifacts_days, agent_runs_days))
);

ALTER TABLE classroom_room ADD COLUMN IF NOT EXISTS retention_policy_id uuid REFERENCES pilot_retention_policy(policy_id);

CREATE TABLE IF NOT EXISTS verified_provider_copy_authority (
  authority_id text PRIMARY KEY CHECK (char_length(authority_id) BETWEEN 1 AND 160),
  record_sha256 char(64) UNIQUE NOT NULL CHECK (record_sha256 ~ '^[a-f0-9]{64}$'),
  issuer_id text NOT NULL CHECK (char_length(issuer_id) BETWEEN 1 AND 128),
  key_id text NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 128),
  provider_id text NOT NULL CHECK (provider_id ~ '^[a-z0-9._-]{1,64}$'),
  provider_manifest_sha256 char(64) NOT NULL CHECK (provider_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  lifecycle_mode text NOT NULL CHECK (lifecycle_mode = 'no_persistent_copy_attested'),
  region text NOT NULL CHECK (char_length(region) BETWEEN 1 AND 64),
  purpose text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 128),
  scope_hash char(64) NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > starts_at),
  revoked_at timestamptz,
  verified_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS student_analytics_promotion (
  room_id uuid PRIMARY KEY REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  promotion_record_sha256 char(64) NOT NULL CHECK (promotion_record_sha256 ~ '^[a-f0-9]{64}$'),
  policy_revision bigint NOT NULL CHECK (policy_revision > 0),
  feature_allowlist text[] NOT NULL,
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > starts_at),
  revoked_at timestamptz,
  CHECK (feature_allowlist <@ ARRAY['echo.student_approved','trace.student_bundle']::text[])
);

CREATE TABLE IF NOT EXISTS security_audit_event (
  security_audit_event_id uuid PRIMARY KEY,
  correlation_id uuid NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind IN ('teacher','student','service','anonymous')),
  action text NOT NULL CHECK (action IN ('room.read','room.command','analytics.read','export.request','deletion.request','deletion.status.read','service.callback')),
  outcome text NOT NULL CHECK (outcome IN ('allowed','rejected','failed')),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z0-9_]{1,64}$'),
  room_ref_sha256 char(64) CHECK (room_ref_sha256 ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deletion_job (
  deletion_job_id uuid PRIMARY KEY,
  correlation_id uuid NOT NULL,
  room_id uuid REFERENCES classroom_room(room_id) ON DELETE SET NULL,
  room_ref_sha256 char(64) NOT NULL CHECK (room_ref_sha256 ~ '^[a-f0-9]{64}$'),
  request_kind text NOT NULL CHECK (request_kind IN ('teacher','retention')),
  policy_version text,
  status text NOT NULL CHECK (status IN ('queued','running','retryable','completed','dead')),
  owner_teacher_id uuid NOT NULL REFERENCES teacher_account(teacher_id),
  requested_by_teacher_id uuid REFERENCES teacher_account(teacher_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((request_kind = 'teacher' AND requested_by_teacher_id IS NOT NULL AND policy_version IS NULL)
      OR (request_kind = 'retention' AND requested_by_teacher_id IS NULL AND policy_version IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS deletion_surface_manifest (
  deletion_job_id uuid NOT NULL REFERENCES deletion_job(deletion_job_id) ON DELETE CASCADE,
  surface text NOT NULL CHECK (surface IN ('events','media','derivatives','artifacts','projections','agent_runs','caches','provider_copies')),
  expected_item_count integer NOT NULL CHECK (expected_item_count >= 0),
  status text NOT NULL CHECK (status IN ('frozen','running','verified','dead')),
  frozen_at timestamptz NOT NULL,
  verified_at timestamptz,
  PRIMARY KEY (deletion_job_id, surface)
);

CREATE TABLE IF NOT EXISTS deletion_receipt (
  deletion_job_id uuid PRIMARY KEY REFERENCES deletion_job(deletion_job_id) ON DELETE CASCADE,
  receipt_version integer NOT NULL CHECK (receipt_version = 1),
  surfaces_verified jsonb NOT NULL CHECK (jsonb_typeof(surfaces_verified) = 'array'),
  completed_at timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS deletion_job_one_unfinished_room_idx
  ON deletion_job(room_id)
  WHERE room_id IS NOT NULL AND status IN ('queued','running','retryable','dead');
