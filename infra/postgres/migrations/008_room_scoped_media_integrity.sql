-- Defense-in-depth room scoping for media provenance.  Service queries already
-- carry room predicates; these NOT VALID constraints additionally protect new
-- writes made by maintenance scripts or future adapters without blocking a
-- controlled legacy backfill.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'room_member_room_actor_unique'
  ) THEN
    ALTER TABLE room_member ADD CONSTRAINT room_member_room_actor_unique
      UNIQUE (room_id, actor_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_asset_room_media_unique'
  ) THEN
    ALTER TABLE media_asset ADD CONSTRAINT media_asset_room_media_unique
      UNIQUE (room_id, media_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'room_event_room_event_unique'
  ) THEN
    ALTER TABLE room_event ADD CONSTRAINT room_event_room_event_unique
      UNIQUE (room_id, event_id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_asset_room_owner_fk'
  ) THEN
    ALTER TABLE media_asset ADD CONSTRAINT media_asset_room_owner_fk
      FOREIGN KEY (room_id, owner_actor_id)
      REFERENCES room_member (room_id, actor_id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_upload_grant_room_media_fk'
  ) THEN
    ALTER TABLE media_upload_grant ADD CONSTRAINT media_upload_grant_room_media_fk
      FOREIGN KEY (room_id, media_id)
      REFERENCES media_asset (room_id, media_id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_write_fence_room_media_fk'
  ) THEN
    ALTER TABLE media_write_fence ADD CONSTRAINT media_write_fence_room_media_fk
      FOREIGN KEY (room_id, media_id)
      REFERENCES media_asset (room_id, media_id) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'media_binding_room_event_fk'
  ) THEN
    ALTER TABLE media_attachment_binding ADD CONSTRAINT media_binding_room_event_fk
      FOREIGN KEY (room_id, source_event_id)
      REFERENCES room_event (room_id, event_id) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION learning_orbit_validate_media_binding_message()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_message text;
BEGIN
  SELECT payload ->> 'messageId'
    INTO source_message
    FROM room_event
   WHERE room_id = NEW.room_id AND event_id = NEW.source_event_id;
  IF source_message IS NULL OR source_message <> NEW.message_id::text THEN
    RAISE EXCEPTION 'MEDIA_BINDING_MESSAGE_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS media_binding_message_scope ON media_attachment_binding;
CREATE TRIGGER media_binding_message_scope
BEFORE INSERT OR UPDATE ON media_attachment_binding
FOR EACH ROW EXECUTE FUNCTION learning_orbit_validate_media_binding_message();
