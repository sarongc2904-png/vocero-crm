ALTER TABLE "durable_job"
  ADD COLUMN IF NOT EXISTS "dead_letter_at" timestamp;

CREATE INDEX IF NOT EXISTS "durable_job_dead_letter_idx"
  ON "durable_job" ("dead_letter_at");
