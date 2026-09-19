CREATE TABLE IF NOT EXISTS "commercial_plan" (
  "id" text PRIMARY KEY NOT NULL,
  "code" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "monthly_price_cents" integer NOT NULL CHECK ("monthly_price_cents" >= 0),
  "currency" text NOT NULL DEFAULT 'MXN',
  "trial_days" integer NOT NULL DEFAULT 3 CHECK ("trial_days" >= 0),
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

INSERT INTO "commercial_plan" (
  "id", "code", "name", "monthly_price_cents", "currency", "trial_days"
) VALUES (
  'plan_conecta_mx', 'conecta_mx_1397', 'Conecta Digital CRM', 139700, 'MXN', 3
) ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name",
  "monthly_price_cents" = EXCLUDED."monthly_price_cents",
  "currency" = EXCLUDED."currency",
  "trial_days" = EXCLUDED."trial_days",
  "updated_at" = now();

CREATE TABLE IF NOT EXISTS "organization_entitlement" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "plan_id" text NOT NULL REFERENCES "commercial_plan"("id"),
  "status" text NOT NULL CHECK ("status" IN ('trial','active','past_due','suspended','cancelled')),
  "trial_started_at" timestamp,
  "trial_ends_at" timestamp,
  "current_period_ends_at" timestamp,
  "suspended_at" timestamp,
  "cancelled_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "organization_entitlement_org_uq" ON "organization_entitlement" ("organization_id");
CREATE INDEX IF NOT EXISTS "organization_entitlement_status_idx" ON "organization_entitlement" ("status");

-- Instalaciones existentes conservan acceso; sólo los tenants nuevos empiezan trial.
INSERT INTO "organization_entitlement" ("id", "organization_id", "plan_id", "status")
SELECT 'ent_' || md5(o."id"), o."id", 'plan_conecta_mx', 'active'
FROM "organization" o
ON CONFLICT ("organization_id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "onboarding_progress" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "current_step" integer NOT NULL DEFAULT 1,
  "completed_steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "activated_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "onboarding_progress_org_uq" ON "onboarding_progress" ("organization_id");

INSERT INTO "onboarding_progress" ("id", "organization_id", "current_step", "completed_steps", "activated_at")
SELECT 'obp_' || md5(o."id"), o."id", 10,
  '["business","timezone","whatsapp","services","professionals","hours","calendar","agent","test","activation"]'::jsonb,
  now()
FROM "organization" o
ON CONFLICT ("organization_id") DO NOTHING;
