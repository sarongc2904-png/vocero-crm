-- SEC-V2 — La exclusion constraint por profesional no distinguía organización.
--
-- La 0021 creó `booking_professional_active_time_excl` con
-- (`professional_id`, `tsrange(...)`) y SIN `organization_id`. Como la clave
-- foránea de `booking.professional_id` es de una sola columna (global), dos
-- tenants quedaban acoplados por el mismo id: una fila del tenant A sobre un
-- `professional_id` ajeno ocupaba la agenda del tenant B — sus reservas
-- legítimas en esa ventana empezaban a fallar con `23P01` → `slot_taken`, sin
-- que la víctima pudiera ver ni diagnosticar el bloqueo.
--
-- La protección anti doble-reserva debe ser POR TENANT. Se recrea la
-- constraint con el mismo semántico más `organization_id`, de modo que dos
-- tenants con profesional y rango equivalentes no se interfieran.
--
-- Forward-only: la 0021 ya está aplicada y no se toca.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "booking"
  DROP CONSTRAINT IF EXISTS "booking_professional_active_time_excl";

DO $$ BEGIN
  ALTER TABLE "booking" ADD CONSTRAINT "booking_org_professional_active_time_excl"
    EXCLUDE USING gist (
      "organization_id" WITH =,
      "professional_id" WITH =,
      tsrange("scheduled_at", "scheduled_at" + ("duration_minutes" * interval '1 minute'), '[)') WITH &&
    ) WHERE ("professional_id" IS NOT NULL AND "status" IN ('agendada','realizada') AND "is_test" = false);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
