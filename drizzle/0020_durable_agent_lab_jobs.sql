CREATE TABLE IF NOT EXISTS "durable_job" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "conversation_id" text REFERENCES "conversation"("id") ON DELETE CASCADE,
  "run_id" text REFERENCES "agent_test_run"("id") ON DELETE CASCADE,
  "requested_at" timestamp DEFAULT now() NOT NULL,
  "due_at" timestamp DEFAULT now() NOT NULL,
  "claimed_request_at" timestamp,
  "lease_until" timestamp,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "durable_job_kind_check"
    CHECK ("kind" IN ('agent_turn', 'lab_run')),
  CONSTRAINT "durable_job_shape_check"
    CHECK (
      ("kind" = 'agent_turn' AND "conversation_id" IS NOT NULL AND "run_id" IS NULL)
      OR
      ("kind" = 'lab_run' AND "run_id" IS NOT NULL AND "conversation_id" IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "durable_job_conversation_uq"
  ON "durable_job" ("conversation_id");

CREATE UNIQUE INDEX IF NOT EXISTS "durable_job_run_uq"
  ON "durable_job" ("run_id");

CREATE INDEX IF NOT EXISTS "durable_job_due_idx"
  ON "durable_job" ("kind", "due_at");

CREATE INDEX IF NOT EXISTS "durable_job_lease_idx"
  ON "durable_job" ("lease_until");
