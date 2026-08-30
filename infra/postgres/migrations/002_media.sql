CREATE TYPE media_kind AS ENUM ('image', 'audio');
CREATE TYPE media_state AS ENUM ('upload_pending', 'uploaded', 'processing', 'ready', 'quarantined', 'failed', 'deleted');
CREATE TYPE media_upload_grant_state AS ENUM ('issuing', 'active', 'promoted', 'revoked', 'expired', 'closed');
CREATE TYPE media_write_fence_state AS ENUM ('active', 'uncertain', 'completed', 'cancelled');

CREATE TABLE media_asset (
  media_id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  owner_actor_id uuid NOT NULL REFERENCES room_member(actor_id) ON DELETE RESTRICT,
  kind media_kind NOT NULL,
  state media_state NOT NULL,
  original_file_name text NOT NULL CHECK (length(original_file_name) BETWEEN 1 AND 255),
  declared_mime text NOT NULL CHECK (length(declared_mime) BETWEEN 1 AND 127),
  detected_mime text CHECK (detected_mime IS NULL OR length(detected_mime) BETWEEN 1 AND 127),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
  declared_sha256 char(64) NOT NULL CHECK (declared_sha256 ~ '^[a-f0-9]{64}$'),
  sha256 char(64) CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  alt_text text,
  caption text,
  object_key text UNIQUE,
  failure_code text CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 100),
  promotion_correlation_id uuid,
  outcome_transition_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'image' OR (alt_text IS NOT NULL AND length(trim(alt_text)) > 0)),
  CHECK (state NOT IN ('uploaded','processing','ready') OR
         (object_key IS NOT NULL AND sha256 IS NOT NULL AND promotion_correlation_id IS NOT NULL))
);

CREATE TABLE media_upload_grant (
  grant_id uuid PRIMARY KEY,
  media_id uuid UNIQUE NOT NULL REFERENCES media_asset(media_id) ON DELETE RESTRICT,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE RESTRICT,
  object_key text UNIQUE NOT NULL,
  state media_upload_grant_state NOT NULL,
  correlation_id uuid NOT NULL,
  reserved_at timestamptz NOT NULL,
  signed_at timestamptz,
  expires_at timestamptz NOT NULL,
  write_not_after timestamptz NOT NULL CHECK (write_not_after >= expires_at),
  activated_at timestamptz,
  promotion_source_etag text,
  promotion_sha256 char(64),
  promotion_destination_key text,
  promotion_correlation_id uuid,
  promotion_started_at timestamptz,
  promotion_write_not_after timestamptz,
  revoked_at timestamptz,
  closed_at timestamptz,
  CHECK ((state IN ('active','promoted') AND activated_at IS NOT NULL AND signed_at IS NOT NULL AND expires_at > signed_at) OR state NOT IN ('active','promoted')),
  CHECK ((promotion_source_etag IS NULL AND promotion_sha256 IS NULL AND promotion_destination_key IS NULL AND promotion_correlation_id IS NULL AND promotion_started_at IS NULL AND promotion_write_not_after IS NULL) OR
         (promotion_source_etag IS NOT NULL AND promotion_sha256 ~ '^[a-f0-9]{64}$' AND promotion_destination_key IS NOT NULL AND promotion_correlation_id IS NOT NULL AND promotion_started_at IS NOT NULL AND promotion_write_not_after >= promotion_started_at))
);

CREATE TABLE media_derivative (
  derivative_id uuid PRIMARY KEY,
  media_id uuid NOT NULL REFERENCES media_asset(media_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('thumbnail', 'sanitized_image', 'playback_audio', 'waveform')),
  object_key text NOT NULL UNIQUE,
  mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (media_id, kind)
);

CREATE TABLE media_attachment_binding (
  media_id uuid PRIMARY KEY REFERENCES media_asset(media_id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  source_event_id uuid NOT NULL REFERENCES room_event(event_id) ON DELETE CASCADE,
  bound_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, message_id, media_id)
);

CREATE TABLE media_write_fence (
  write_fence_id uuid PRIMARY KEY,
  media_id uuid NOT NULL REFERENCES media_asset(media_id) ON DELETE RESTRICT,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE RESTRICT,
  worker_job_id uuid NOT NULL REFERENCES worker_job(job_id) ON DELETE RESTRICT,
  worker_attempt integer NOT NULL CHECK (worker_attempt > 0),
  claim_generation bigint NOT NULL CHECK (claim_generation > 0),
  claim_token uuid NOT NULL,
  operation text NOT NULL CHECK (operation = 'derivative_write'),
  state media_write_fence_state NOT NULL,
  write_not_after timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (worker_job_id, claim_generation, operation),
  CHECK ((state IN ('completed','cancelled')) = (completed_at IS NOT NULL))
);

CREATE INDEX media_asset_room_state_idx ON media_asset(room_id, state);
CREATE INDEX media_upload_grant_room_state_idx ON media_upload_grant(room_id, state, write_not_after);
CREATE INDEX media_write_fence_room_state_idx ON media_write_fence(room_id, state, write_not_after);
