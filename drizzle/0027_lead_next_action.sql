ALTER TABLE "lead"
  ADD COLUMN "next_action_type" text,
  ADD COLUMN "next_action_at" timestamp,
  ADD COLUMN "next_action_note" text;

ALTER TABLE "lead"
  ADD CONSTRAINT "lead_next_action_type_ck"
  CHECK (
    "next_action_type" IS NULL OR
    "next_action_type" IN ('llamar', 'whatsapp', 'cotizacion', 'seguimiento', 'cita', 'otro')
  );

CREATE INDEX "lead_org_next_action_idx"
  ON "lead" ("organization_id", "next_action_at");
