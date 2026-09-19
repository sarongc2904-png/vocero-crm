CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS "service" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "category" text,
  "duration_minutes" integer NOT NULL CHECK ("duration_minutes" BETWEEN 5 AND 1440),
  "price_cents" integer NOT NULL CHECK ("price_cents" >= 0),
  "currency" text NOT NULL DEFAULT 'MXN',
  "active" boolean NOT NULL DEFAULT true,
  "buffer_before_minutes" integer NOT NULL DEFAULT 0 CHECK ("buffer_before_minutes" >= 0),
  "buffer_after_minutes" integer NOT NULL DEFAULT 0 CHECK ("buffer_after_minutes" >= 0),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "service_org_name_uq" ON "service" ("organization_id", "name");
CREATE INDEX IF NOT EXISTS "service_org_active_idx" ON "service" ("organization_id", "active");

CREATE TABLE IF NOT EXISTS "professional" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active' CHECK ("status" IN ('active','inactive')),
  "phone" text,
  "email" text,
  "user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "timezone" text NOT NULL DEFAULT 'America/Mexico_City',
  "color" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "professional_org_name_uq" ON "professional" ("organization_id", "name");
CREATE INDEX IF NOT EXISTS "professional_org_status_idx" ON "professional" ("organization_id", "status");

CREATE TABLE IF NOT EXISTS "professional_service" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "professional_id" text NOT NULL REFERENCES "professional"("id") ON DELETE CASCADE,
  "service_id" text NOT NULL REFERENCES "service"("id") ON DELETE CASCADE,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "professional_service_org_uq" ON "professional_service" ("organization_id", "professional_id", "service_id");
CREATE INDEX IF NOT EXISTS "professional_service_service_idx" ON "professional_service" ("organization_id", "service_id");

CREATE TABLE IF NOT EXISTS "professional_availability" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "professional_id" text NOT NULL REFERENCES "professional"("id") ON DELETE CASCADE,
  "day_of_week" integer NOT NULL CHECK ("day_of_week" BETWEEN 0 AND 6),
  "start_minute" integer NOT NULL,
  "end_minute" integer NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CHECK ("start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute")
);
CREATE INDEX IF NOT EXISTS "professional_availability_org_prof_idx" ON "professional_availability" ("organization_id", "professional_id", "day_of_week");

CREATE TABLE IF NOT EXISTS "professional_break" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "professional_id" text NOT NULL REFERENCES "professional"("id") ON DELETE CASCADE,
  "day_of_week" integer NOT NULL CHECK ("day_of_week" BETWEEN 0 AND 6),
  "start_minute" integer NOT NULL,
  "end_minute" integer NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CHECK ("start_minute" >= 0 AND "end_minute" <= 1440 AND "start_minute" < "end_minute")
);
CREATE INDEX IF NOT EXISTS "professional_break_org_prof_idx" ON "professional_break" ("organization_id", "professional_id", "day_of_week");

CREATE TABLE IF NOT EXISTS "professional_time_off" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "professional_id" text NOT NULL REFERENCES "professional"("id") ON DELETE CASCADE,
  "starts_at" timestamp NOT NULL,
  "ends_at" timestamp NOT NULL,
  "reason" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CHECK ("starts_at" < "ends_at")
);
CREATE INDEX IF NOT EXISTS "professional_time_off_org_prof_idx" ON "professional_time_off" ("organization_id", "professional_id", "starts_at");

ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "service_id" text REFERENCES "service"("id") ON DELETE SET NULL;
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "professional_id" text REFERENCES "professional"("id") ON DELETE SET NULL;
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "timezone" text NOT NULL DEFAULT 'America/Mexico_City';
CREATE INDEX IF NOT EXISTS "booking_org_prof_when_idx" ON "booking" ("organization_id", "professional_id", "scheduled_at");

ALTER TABLE "offered_slot" ADD COLUMN IF NOT EXISTS "service_id" text REFERENCES "service"("id") ON DELETE CASCADE;
ALTER TABLE "offered_slot" ADD COLUMN IF NOT EXISTS "professional_id" text REFERENCES "professional"("id") ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS "booking_event" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "booking_id" text NOT NULL REFERENCES "booking"("id") ON DELETE CASCADE,
  "type" text NOT NULL CHECK ("type" IN ('created','rescheduled','cancelled','status_changed','sync_failed')),
  "from_start" timestamp,
  "to_start" timestamp,
  "from_status" text,
  "to_status" text,
  "actor_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "idempotency_key" text,
  "detail" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "booking_event_org_booking_idx" ON "booking_event" ("organization_id", "booking_id");
CREATE UNIQUE INDEX IF NOT EXISTS "booking_event_org_idempotency_uq" ON "booking_event" ("organization_id", "idempotency_key");

DROP INDEX IF EXISTS "booking_org_active_slot_uq";
DO $$ BEGIN
  ALTER TABLE "booking" ADD CONSTRAINT "booking_professional_active_time_excl"
    EXCLUDE USING gist (
      "professional_id" WITH =,
      tsrange("scheduled_at", "scheduled_at" + ("duration_minutes" * interval '1 minute'), '[)') WITH &&
    ) WHERE ("professional_id" IS NOT NULL AND "status" IN ('agendada','realizada') AND "is_test" = false);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
