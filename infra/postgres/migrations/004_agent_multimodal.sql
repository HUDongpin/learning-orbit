DO $$ BEGIN
  CREATE TYPE agent_run_state AS ENUM ('queued','running','streaming','completed','blocked_by_policy','cancelled','failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE classroom_room ADD COLUMN IF NOT EXISTS agent_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE worker_job ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;

CREATE TABLE IF NOT EXISTS agent_run (
  agent_run_id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  state agent_run_state NOT NULL,
  trigger_event_id uuid NOT NULL REFERENCES room_event(event_id) ON DELETE CASCADE,
  requested_by_teacher_id uuid REFERENCES teacher_account(teacher_id) ON DELETE CASCADE,
  requested_by_room_member_id uuid REFERENCES room_member(room_member_id) ON DELETE CASCADE,
  input_from_room_seq bigint NOT NULL CHECK (input_from_room_seq >= 1),
  input_through_room_seq bigint NOT NULL CHECK (input_through_room_seq >= input_from_room_seq),
  correlation_id uuid NOT NULL,
  model_provider text NOT NULL CHECK (char_length(model_provider) BETWEEN 1 AND 128),
  model_id text NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 128),
  prompt_version text NOT NULL CHECK (char_length(prompt_version) BETWEEN 1 AND 128),
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 128),
  failure_code text CHECK (failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 100),
  token_input bigint CHECK (token_input IS NULL OR token_input >= 0),
  token_output bigint CHECK (token_output IS NULL OR token_output >= 0),
  cost_microunits bigint CHECK (cost_microunits IS NULL OR cost_microunits >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((requested_by_teacher_id IS NOT NULL)::int + (requested_by_room_member_id IS NOT NULL)::int = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_agent_run_per_room
  ON agent_run(room_id) WHERE state IN ('queued','running','streaming');
CREATE UNIQUE INDEX IF NOT EXISTS one_agent_run_per_trigger
  ON agent_run(room_id, trigger_event_id);

CREATE TABLE IF NOT EXISTS agent_run_transition (
  transition_id uuid PRIMARY KEY,
  agent_run_id uuid NOT NULL REFERENCES agent_run(agent_run_id) ON DELETE CASCADE,
  from_state agent_run_state,
  to_state agent_run_state NOT NULL,
  reason_code text CHECK (reason_code IS NULL OR char_length(reason_code) BETWEEN 1 AND 100),
  causation_id uuid NOT NULL UNIQUE,
  transitioned_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_control_event (
  control_event_id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  teacher_id uuid NOT NULL REFERENCES teacher_account(teacher_id),
  action text NOT NULL CHECK (action IN ('enable','disable','cancel_requested')),
  agent_run_id uuid REFERENCES agent_run(agent_run_id),
  causation_id uuid NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_provider_health (
  provider_id text PRIMARY KEY CHECK (provider_id ~ '^[a-z0-9._-]{1,64}$'),
  manifest_sha256 char(64) NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  health text NOT NULL CHECK (health IN ('healthy','degraded','unavailable')),
  checked_at timestamptz NOT NULL,
  reason_code text CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z0-9_]{1,64}$'),
  signature_key_id text NOT NULL,
  signature bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS moderation_decision (
  decision_id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  subject_kind text NOT NULL CHECK (subject_kind IN ('agent_output','derived_artifact','media')),
  subject_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('allow','warn','hold','redact')),
  policy_version text NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 128),
  reason_codes jsonb NOT NULL,
  decided_by text NOT NULL CHECK (decided_by IN ('deterministic_policy','approved_provider','teacher')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(subject_kind, subject_id, policy_version)
);

CREATE INDEX IF NOT EXISTS agent_run_room_updated_idx ON agent_run(room_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS agent_transition_run_time_idx ON agent_run_transition(agent_run_id, transitioned_at);
