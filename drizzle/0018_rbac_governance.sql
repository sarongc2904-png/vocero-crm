ALTER TABLE "member"
  ADD COLUMN IF NOT EXISTS "suspended_at" timestamp,
  ADD COLUMN IF NOT EXISTS "suspension_reason" text,
  ADD COLUMN IF NOT EXISTS "suspended_by" text REFERENCES "user"("id") ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS "team" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_org_name_uq"
  ON "team" ("organization_id", lower("name"));
CREATE INDEX IF NOT EXISTS "team_org_idx"
  ON "team" ("organization_id");

CREATE TABLE IF NOT EXISTS "team_member" (
  "team_id" text NOT NULL REFERENCES "team"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "member_id" text NOT NULL REFERENCES "member"("id") ON DELETE CASCADE,
  "created_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("team_id", "member_id")
);

CREATE INDEX IF NOT EXISTS "team_member_org_idx"
  ON "team_member" ("organization_id", "team_id");
CREATE INDEX IF NOT EXISTS "team_member_member_idx"
  ON "team_member" ("organization_id", "member_id");

CREATE TABLE IF NOT EXISTS "privileged_audit_log" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "actor_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "actor_mode" text NOT NULL CHECK ("actor_mode" IN ('member', 'superadmin')),
  "action" text NOT NULL,
  "target_type" text,
  "target_id" text,
  "metadata" jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "privileged_audit_org_created_idx"
  ON "privileged_audit_log" ("organization_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "privileged_audit_actor_idx"
  ON "privileged_audit_log" ("actor_user_id", "created_at" DESC);
