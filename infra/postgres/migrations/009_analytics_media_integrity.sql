-- Keep derived multimodal artifacts room-scoped even when a future ASR/OCR
-- adapter writes a source media reference.  Migration 008 supplies the
-- composite media key; these constraints are NOT VALID so an explicit,
-- auditable legacy backfill can precede validation without weakening new
-- writes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'derived_text_room_artifact_unique'
  ) THEN
    ALTER TABLE derived_text_artifact
      ADD CONSTRAINT derived_text_room_artifact_unique
      UNIQUE (room_id, artifact_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'derived_text_artifact_room_media_fk'
  ) THEN
    ALTER TABLE derived_text_artifact
      ADD CONSTRAINT derived_text_artifact_room_media_fk
      FOREIGN KEY (room_id, source_media_id)
      REFERENCES media_asset (room_id, media_id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'extraction_artifact_room_artifact_fk'
  ) THEN
    ALTER TABLE extraction_artifacts
      ADD CONSTRAINT extraction_artifact_room_artifact_fk
      FOREIGN KEY (room_id, artifact_id)
      REFERENCES derived_text_artifact (room_id, artifact_id) NOT VALID;
  END IF;
END $$;
