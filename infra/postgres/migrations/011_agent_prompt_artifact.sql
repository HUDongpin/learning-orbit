-- What Nova was actually asked, recorded without becoming a second copy of the
-- classroom.
--
-- The prompt is not stored. It is exactly the room's own events over a
-- recorded sequence range, so keeping the rendered text would create another
-- content store that deletion has to find, that retention has to expire, and
-- that a leak would expose twice. The hash proves which prompt was sent; the
-- ledger plus the recorded bounds reproduces it, and if the two ever disagree
-- the hash is what says so.
--
-- One row per run. A second, different prompt for the same run is not a later
-- version of anything — it means two different things were sent under one run
-- id, which the primary key refuses outright.
CREATE TABLE IF NOT EXISTS agent_prompt_artifact (
  agent_run_id uuid PRIMARY KEY REFERENCES agent_run(agent_run_id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES classroom_room(room_id) ON DELETE CASCADE,
  prompt_version text NOT NULL CHECK (char_length(prompt_version) BETWEEN 1 AND 128),
  -- sha256 of the exact bytes handed to the provider, system prompt included.
  prompt_sha256 char(64) NOT NULL CHECK (prompt_sha256 ~ '^[a-f0-9]{64}$'),
  system_sha256 char(64) NOT NULL CHECK (system_sha256 ~ '^[a-f0-9]{64}$'),
  context_from_room_seq bigint NOT NULL CHECK (context_from_room_seq >= 1),
  context_through_room_seq bigint NOT NULL,
  context_event_ids uuid[] NOT NULL CHECK (cardinality(context_event_ids) BETWEEN 1 AND 30),
  approved_artifact_ids uuid[] NOT NULL CHECK (cardinality(approved_artifact_ids) <= 30),
  model_provider text NOT NULL CHECK (char_length(model_provider) BETWEEN 1 AND 128),
  model_id text NOT NULL CHECK (char_length(model_id) BETWEEN 1 AND 128),
  provider_manifest_sha256 char(64) NOT NULL CHECK (provider_manifest_sha256 ~ '^[a-f0-9]{64}$'),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 8192),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (context_through_room_seq >= context_from_room_seq)
);

CREATE INDEX IF NOT EXISTS agent_prompt_artifact_room
  ON agent_prompt_artifact(room_id, created_at DESC);
