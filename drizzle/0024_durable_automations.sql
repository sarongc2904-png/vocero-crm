CREATE TABLE IF NOT EXISTS "automation_rule" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('follow_up','appointment_reminder','review_request','reactivation')),
  "enabled" boolean NOT NULL DEFAULT false,
  "delay_minutes" integer NOT NULL CHECK ("delay_minutes" >= 0),
  "message_text" text,
  "template_id" text REFERENCES "template"("id") ON DELETE SET NULL,
  "config" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "automation_rule_org_kind_idx" ON "automation_rule" ("organization_id", "kind");

CREATE TABLE IF NOT EXISTS "scheduled_automation" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "rule_id" text REFERENCES "automation_rule"("id") ON DELETE SET NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('follow_up','appointment_reminder','review_request','reactivation')),
  "status" text NOT NULL DEFAULT 'scheduled' CHECK ("status" IN ('scheduled','pending','processing','completed','cancelled','failed')),
  "conversation_id" text REFERENCES "conversation"("id") ON DELETE CASCADE,
  "contact_id" text REFERENCES "contact"("id") ON DELETE CASCADE,
  "booking_id" text REFERENCES "booking"("id") ON DELETE CASCADE,
  "due_at" timestamp NOT NULL,
  "lease_until" timestamp,
  "attempts" integer NOT NULL DEFAULT 0,
  "idempotency_key" text NOT NULL,
  "message_text" text,
  "template_id" text REFERENCES "template"("id") ON DELETE SET NULL,
  "payload" jsonb,
  "last_error" text,
  "completed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "scheduled_automation_org_idempotency_uq" ON "scheduled_automation" ("organization_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "scheduled_automation_due_idx" ON "scheduled_automation" ("status", "due_at");
CREATE INDEX IF NOT EXISTS "scheduled_automation_org_booking_idx" ON "scheduled_automation" ("organization_id", "booking_id");
