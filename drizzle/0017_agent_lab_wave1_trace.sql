-- Wave 1 (F009/F010): persist deterministic Lab action traces separately from verdicts.
-- The trace is tenant-scoped and tied to exactly one test case.
CREATE TABLE IF NOT EXISTS "agent_test_action_trace" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "test_case_id" text NOT NULL REFERENCES "agent_test_case"("id") ON DELETE CASCADE,
  "trace" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_test_action_trace_org_case_uq"
  ON "agent_test_action_trace" ("organization_id", "test_case_id");
CREATE INDEX IF NOT EXISTS "agent_test_action_trace_org_created_idx"
  ON "agent_test_action_trace" ("organization_id", "created_at");
