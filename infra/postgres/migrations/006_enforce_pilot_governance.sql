-- Existing development databases can contain pre-governance synthetic rooms.
-- A NOT VALID check is the safe rollout boundary: it enforces every new room
-- immediately while leaving an explicit, auditable backfill for old rows.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'classroom_room'::regclass
      AND conname = 'classroom_room_retention_policy_required'
  ) THEN
    ALTER TABLE classroom_room ADD CONSTRAINT classroom_room_retention_policy_required
      CHECK (retention_policy_id IS NOT NULL) NOT VALID;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION learning_orbit_reject_retention_policy_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'RETENTION_POLICY_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pilot_retention_policy_immutable ON pilot_retention_policy;
CREATE TRIGGER pilot_retention_policy_immutable
BEFORE UPDATE ON pilot_retention_policy
FOR EACH ROW EXECUTE FUNCTION learning_orbit_reject_retention_policy_change();
