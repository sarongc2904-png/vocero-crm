CREATE TABLE IF NOT EXISTS "conversation_assignment" (
  "conversation_id" text PRIMARY KEY REFERENCES "conversation"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "member_id" text REFERENCES "member"("id") ON DELETE SET NULL,
  "team_id" text REFERENCES "team"("id") ON DELETE SET NULL,
  "assigned_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CHECK (num_nonnulls("member_id", "team_id") = 1)
);

CREATE INDEX IF NOT EXISTS "conversation_assignment_org_idx"
  ON "conversation_assignment" ("organization_id", "conversation_id");
CREATE INDEX IF NOT EXISTS "conversation_assignment_member_idx"
  ON "conversation_assignment" ("organization_id", "member_id");
CREATE INDEX IF NOT EXISTS "conversation_assignment_team_idx"
  ON "conversation_assignment" ("organization_id", "team_id");
