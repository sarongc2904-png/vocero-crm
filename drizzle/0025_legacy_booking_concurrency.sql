-- Las instalaciones anteriores al catálogo beauty guardan citas sin
-- professional_id. La exclusion constraint por profesional no las cubre.
-- Un trigger con advisory lock tenant-scoped protege escrituras nuevas sin
-- exigir que instalaciones existentes reescriban o borren datos históricos.
CREATE OR REPLACE FUNCTION prevent_legacy_booking_overlap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.professional_id IS NULL
     AND NEW.status IN ('agendada', 'realizada')
     AND NEW.is_test = false THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id, 0));

    IF EXISTS (
      SELECT 1
      FROM booking b
      WHERE b.organization_id = NEW.organization_id
        AND b.id <> NEW.id
        AND b.professional_id IS NULL
        AND b.status IN ('agendada', 'realizada')
        AND b.is_test = false
        AND tsrange(
          b.scheduled_at,
          b.scheduled_at + (b.duration_minutes * interval '1 minute'),
          '[)'
        ) && tsrange(
          NEW.scheduled_at,
          NEW.scheduled_at + (NEW.duration_minutes * interval '1 minute'),
          '[)'
        )
    ) THEN
      RAISE EXCEPTION 'legacy booking overlaps an active booking'
        USING ERRCODE = '23P01',
              CONSTRAINT = 'booking_legacy_active_time_guard';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS booking_legacy_active_time_guard ON booking;
CREATE TRIGGER booking_legacy_active_time_guard
BEFORE INSERT OR UPDATE OF organization_id, professional_id, scheduled_at,
  duration_minutes, status, is_test
ON booking
FOR EACH ROW
EXECUTE FUNCTION prevent_legacy_booking_overlap();
