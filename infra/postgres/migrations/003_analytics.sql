-- Analytics is a read model over room_event.  It never replaces the room ledger.
ALTER TABLE worker_job
  ADD COLUMN analytics_order_seq bigint,
  ADD COLUMN analytics_order_kind smallint,
  ADD CONSTRAINT worker_job_analytics_order_ck CHECK (
    (job_type = 'analytics.consume.v1'
      AND analytics_order_seq IS NOT NULL
      AND analytics_order_kind IS NOT NULL
      AND analytics_order_seq > 0 AND analytics_order_kind = 0)
    OR (job_type = 'analytics.replay-room.v1'
      AND analytics_order_seq IS NOT NULL
      AND analytics_order_kind IS NOT NULL
      AND analytics_order_seq >= 0 AND analytics_order_kind = 1)
    OR (job_type NOT IN ('analytics.consume.v1', 'analytics.replay-room.v1')
      AND analytics_order_seq IS NULL AND analytics_order_kind IS NULL)
  );

CREATE TABLE analytics_replay_request (
  job_id uuid PRIMARY KEY REFERENCES worker_job(job_id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  source_event_id uuid REFERENCES room_event(event_id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN
    ('late_event', 'artifact_available', 'analytics_review', 'operator_rebuild')),
  requested_through_room_seq bigint NOT NULL CHECK (requested_through_room_seq >= 0),
  dedupe_key text NOT NULL UNIQUE,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE derived_text_artifact (
  artifact_id uuid PRIMARY KEY,
  lineage_id uuid NOT NULL,
  event_id uuid NOT NULL REFERENCES room_event(event_id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  room_seq bigint NOT NULL CHECK (room_seq > 0),
  source_media_id uuid NULL REFERENCES media_asset(media_id) ON DELETE CASCADE,
  source_modality text NOT NULL CHECK (source_modality IN ('text', 'audio', 'image')),
  derivation text NOT NULL CHECK (derivation IN
    ('direct', 'asr', 'ocr', 'image_description', 'human_correction')),
  text_content text NOT NULL CHECK (length(text_content) BETWEEN 1 AND 20000),
  normalized_text_sha256 char(64) NOT NULL CHECK (normalized_text_sha256 ~ '^[a-f0-9]{64}$'),
  source_confidence_raw double precision NOT NULL CHECK (source_confidence_raw BETWEEN 0 AND 1),
  source_confidence_calibrated double precision CHECK
    (source_confidence_calibrated IS NULL OR source_confidence_calibrated BETWEEN 0 AND 1),
  provider text NOT NULL,
  model_version text NOT NULL,
  language_tag text NOT NULL,
  spans jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(spans) = 'array'),
  review_status text NOT NULL CHECK (review_status IN
    ('unreviewed', 'approved', 'rejected', 'corrected')),
  display_status text NOT NULL CHECK (display_status IN
    ('hidden', 'teacher_shadow', 'student_approved')),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(warnings) = 'array'),
  supersedes_artifact_id uuid REFERENCES derived_text_artifact(artifact_id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  CHECK (derivation <> 'human_correction' OR supersedes_artifact_id IS NOT NULL),
  CHECK (supersedes_artifact_id IS NULL OR supersedes_artifact_id <> artifact_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lineage_id, event_id, derivation, model_version, normalized_text_sha256)
);

CREATE TABLE extraction_artifacts (
  extraction_id uuid PRIMARY KEY,
  artifact_id uuid NOT NULL REFERENCES derived_text_artifact(artifact_id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  room_seq bigint NOT NULL CHECK (room_seq > 0),
  algorithm text NOT NULL CHECK (algorithm IN ('ECHO-CM', 'TRACE-AI')),
  extractor_version text NOT NULL,
  output jsonb NOT NULL,
  output_sha256 char(64) NOT NULL CHECK (output_sha256 ~ '^[a-f0-9]{64}$'),
  extraction_confidence_raw double precision CHECK
    (extraction_confidence_raw IS NULL OR extraction_confidence_raw BETWEEN 0 AND 1),
  extraction_confidence_calibrated double precision CHECK
    (extraction_confidence_calibrated IS NULL OR extraction_confidence_calibrated BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artifact_id, algorithm, extractor_version, output_sha256)
);

CREATE TABLE analysis_projection_snapshots (
  snapshot_id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  algorithm text NOT NULL CHECK (algorithm IN ('ECHO-CM', 'TRACE-AI')),
  projection_key text NOT NULL,
  analysis_epoch uuid NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  complete_through_seq bigint NOT NULL CHECK (complete_through_seq >= 0),
  watermark_event_time timestamptz NOT NULL,
  requires_replay boolean NOT NULL DEFAULT false,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  algorithm_version text NOT NULL,
  parameter_hash char(64) NOT NULL CHECK (parameter_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, projection_key, analysis_epoch, version)
);

CREATE TABLE analysis_projection_patches (
  patch_id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  projection_key text NOT NULL,
  analysis_epoch uuid NOT NULL,
  base_version bigint NOT NULL CHECK (base_version >= 0),
  version bigint NOT NULL CHECK (version = base_version + 1),
  complete_through_seq bigint NOT NULL CHECK (complete_through_seq >= 0),
  algorithm_version text NOT NULL,
  parameter_hash char(64) NOT NULL CHECK (parameter_hash ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, projection_key, analysis_epoch, version)
);

CREATE TABLE analysis_projection_outbox (
  projection_outbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  projection_key text NOT NULL,
  analysis_epoch uuid NOT NULL,
  projection_version bigint NOT NULL CHECK (projection_version >= 1),
  complete_through_room_seq bigint NOT NULL CHECK (complete_through_room_seq >= 0),
  snapshot_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  publish_attempts integer NOT NULL DEFAULT 0,
  published_at timestamptz,
  last_error text,
  UNIQUE (room_id, projection_key, analysis_epoch, projection_version)
);

CREATE TABLE analysis_room_heads (
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  projection_key text NOT NULL,
  analysis_epoch uuid NOT NULL,
  version bigint NOT NULL CHECK (version >= 0),
  complete_through_seq bigint NOT NULL CHECK (complete_through_seq >= 0),
  algorithm_version text NOT NULL,
  parameter_hash char(64) NOT NULL CHECK (parameter_hash ~ '^[a-f0-9]{64}$'),
  max_seen_event_time timestamptz NOT NULL,
  watermark_event_time timestamptz NOT NULL,
  requires_replay boolean NOT NULL DEFAULT false,
  snapshot_id uuid REFERENCES analysis_projection_snapshots(snapshot_id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, projection_key)
);

CREATE TABLE analysis_consumer_checkpoints (
  consumer_name text NOT NULL,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  last_room_seq bigint NOT NULL CHECK (last_room_seq >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer_name, room_id)
);

CREATE TABLE analytics_review_detail (
  review_detail_id uuid PRIMARY KEY,
  review_event_id uuid NOT NULL UNIQUE REFERENCES room_event(event_id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  change_kind text NOT NULL CHECK (change_kind IN ('review', 'correction')),
  validated_payload jsonb NOT NULL CHECK (jsonb_typeof(validated_payload) = 'object'),
  reviewer_teacher_id uuid NOT NULL REFERENCES teacher_account(teacher_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX derived_text_room_seq_idx ON derived_text_artifact(room_id, room_seq);
CREATE UNIQUE INDEX derived_text_one_active_lineage_idx
  ON derived_text_artifact(lineage_id) WHERE active;
CREATE INDEX derived_text_review_queue_idx
  ON derived_text_artifact(room_id, review_status, active, created_at, artifact_id);
CREATE INDEX extraction_room_seq_idx ON extraction_artifacts(room_id, room_seq, algorithm);
CREATE INDEX analytics_snapshot_latest_idx
  ON analysis_projection_snapshots(room_id, projection_key, analysis_epoch, version DESC);
CREATE INDEX analytics_patch_resume_idx
  ON analysis_projection_patches(room_id, projection_key, analysis_epoch, version);
CREATE INDEX analytics_projection_outbox_claim_idx
  ON analysis_projection_outbox(projection_outbox_id)
  WHERE published_at IS NULL;
