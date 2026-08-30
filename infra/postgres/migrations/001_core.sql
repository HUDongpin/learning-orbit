CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE FUNCTION learning_orbit_room_lock_key(p_room_id uuid)
RETURNS bigint LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT hashtextextended('learning-orbit-room-v1:' || p_room_id::text, 0)
$$;

CREATE TABLE teacher_account (
  teacher_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL CHECK (email = lower(email)),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE magic_link (
  magic_link_id uuid PRIMARY KEY,
  teacher_id uuid NOT NULL REFERENCES teacher_account ON DELETE CASCADE,
  token_hash bytea UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE TABLE classroom_room (
  room_id uuid PRIMARY KEY,
  room_code_hash bytea NOT NULL UNIQUE,
  nova_actor_id uuid NOT NULL UNIQUE,
  teacher_id uuid NOT NULL REFERENCES teacher_account,
  topic text NOT NULL CHECK (char_length(topic) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'open', 'paused', 'closed')),
  duration_seconds int NOT NULL DEFAULT 2700 CHECK (duration_seconds = 2700),
  starts_at timestamptz,
  closes_at timestamptz,
  closed_at timestamptz,
  next_room_seq bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE room_member (
  room_member_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL UNIQUE,
  room_id uuid NOT NULL REFERENCES classroom_room ON DELETE CASCADE,
  seat_index smallint NOT NULL CHECK (seat_index BETWEEN 1 AND 4),
  pseudonym text NOT NULL,
  code_hash bytea NOT NULL,
  UNIQUE (room_id, seat_index),
  UNIQUE (room_id, pseudonym),
  UNIQUE (room_id, code_hash)
);

CREATE TABLE auth_session (
  session_id uuid PRIMARY KEY,
  token_hash bytea UNIQUE NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind IN ('teacher', 'student')),
  teacher_id uuid REFERENCES teacher_account ON DELETE CASCADE,
  room_member_id uuid REFERENCES room_member ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (principal_kind = 'teacher' AND teacher_id IS NOT NULL AND room_member_id IS NULL)
    OR
    (principal_kind = 'student' AND teacher_id IS NULL AND room_member_id IS NOT NULL)
  )
);

CREATE TABLE room_event (
  event_id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES classroom_room ON DELETE CASCADE,
  room_seq bigint NOT NULL,
  schema_version int NOT NULL DEFAULT 1,
  type text NOT NULL,
  actor_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
  actor_role text NOT NULL,
  revision int NOT NULL CHECK (revision >= 1),
  operation text NOT NULL CHECK (operation IN ('add', 'revise', 'retract')),
  event_time timestamptz NOT NULL,
  ingest_time timestamptz NOT NULL,
  causation_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (room_id, room_seq),
  UNIQUE (room_id, causation_id)
);

CREATE INDEX room_event_resume_idx ON room_event (room_id, room_seq);
CREATE INDEX room_event_message_idx ON room_event (room_id, ((payload ->> 'messageId')), revision DESC);

CREATE TABLE outbox_event (
  outbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid UNIQUE NOT NULL REFERENCES room_event ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES classroom_room ON DELETE CASCADE,
  room_seq bigint NOT NULL,
  topic text NOT NULL DEFAULT 'learning_orbit.room_event.v1',
  envelope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  publish_attempts int NOT NULL DEFAULT 0,
  published_at timestamptz,
  last_error text
);

CREATE INDEX outbox_event_claim_idx ON outbox_event (available_at, created_at) WHERE published_at IS NULL;

CREATE TABLE worker_job (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type text NOT NULL,
  room_id uuid REFERENCES classroom_room ON DELETE CASCADE,
  source_event_id uuid REFERENCES room_event ON DELETE CASCADE,
  dedupe_key text UNIQUE NOT NULL,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'retryable', 'dead', 'cancelled')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL DEFAULT now(),
  claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  claim_token uuid,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT worker_job_lease_check CHECK (
    (status = 'running' AND claim_token IS NOT NULL AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
    OR
    (status <> 'running' AND claim_token IS NULL AND locked_at IS NULL AND locked_by IS NULL)
  )
);

CREATE INDEX worker_job_claim_idx ON worker_job (run_after, created_at)
  WHERE status IN ('queued', 'retryable', 'running');

CREATE TABLE worker_job_completion (
  job_id uuid NOT NULL REFERENCES worker_job(job_id) ON DELETE CASCADE,
  claim_generation bigint NOT NULL CHECK (claim_generation > 0),
  claim_token_hash char(64) NOT NULL CHECK (claim_token_hash ~ '^[a-f0-9]{64}$'),
  completion_code text NOT NULL CHECK (completion_code ~ '^[A-Z0-9_]{1,64}$'),
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, claim_generation),
  UNIQUE (job_id, claim_token_hash)
);
