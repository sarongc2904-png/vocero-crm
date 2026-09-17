ALTER TABLE "member"
  ADD COLUMN IF NOT EXISTS "suspended_at" timestamp,
  ADD COLUMN IF NOT EXISTS "suspended_by" text REFERENCES "user"("id") ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS "team_group" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_group_org_name_uq"
  ON "team_group" ("organization_id", lower("name"));
CREATE INDEX IF NOT EXISTS "team_group_org_idx"
  ON "team_group" ("organization_id");

CREATE TABLE IF NOT EXISTS "team_assignment" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "team_id" text NOT NULL REFERENCES "team_group"("id") ON DELETE CASCADE,
  "member_id" text NOT NULL REFERENCES "member"("id") ON DELETE CASCADE,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_assignment_org_team_member_uq"
  ON "team_assignment" ("organization_id", "team_id", "member_id");
CREATE INDEX IF NOT EXISTS "team_assignment_org_idx"
  ON "team_assignment" ("organization_id");

CREATE TABLE IF NOT EXISTS "privileged_audit_log" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "actor_user_id" text NOT NULL REFERENCES "user"("id") ON DELETE RESTRICT,
  "actor_kind" text NOT NULL CHECK ("actor_kind" IN ('member', 'superadmin')),
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "privileged_audit_log_org_created_idx"
  ON "privileged_audit_log" ("organization_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "privileged_audit_log_actor_idx"
  ON "privileged_audit_log" ("actor_user_id", "created_at" DESC);
