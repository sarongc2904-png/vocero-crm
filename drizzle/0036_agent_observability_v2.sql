-- Observabilidad de agente v2 (Action Trace v2 + Evidence Snapshot).
--
-- 1) El action trace gana versión y digest: la fila pasa a ser verificable
--    (¿alguien editó el jsonb después?) y distinguible de las filas v1 ya
--    persistidas, que siguen siendo válidas.
-- 2) Nace agent_test_evidence_snapshot: la evidencia EXACTA que vio el juez,
--    congelada, más su registro reproducible (prompt, digest de entrada,
--    veredicto crudo y veredicto final). Antes el conocimiento del juez se
--    recalculaba al juzgar, así que no había forma de auditar con qué
--    información se había emitido un veredicto.
--
-- Se conservan las FKs simples por contrato histórico y se añade la FK
-- compuesta (organization_id, test_case_id) con el mismo patrón de la 0035:
-- el organization_id del hijo no puede diferir del organization_id del padre.

ALTER TABLE "agent_test_action_trace"
  ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;
ALTER TABLE "agent_test_action_trace"
  ADD COLUMN IF NOT EXISTS "digest" text;

CREATE TABLE IF NOT EXISTS "agent_run" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "conversation_id" text NOT NULL REFERENCES "conversation"("id") ON DELETE CASCADE,
  "inbound_message_id" text REFERENCES "message"("id") ON DELETE SET NULL,
  "outbound_message_id" text REFERENCES "message"("id") ON DELETE SET NULL,
  "provider" text,
  "model" text,
  "status" text NOT NULL DEFAULT 'running',
  "trace_id" text NOT NULL,
  "action_count" integer NOT NULL DEFAULT 0,
  "evidence_count" integer NOT NULL DEFAULT 0,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "completed_at" timestamp,
  "error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "agent_run_status_ck" CHECK ("status" IN ('running','completed','failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_run_org_id_uq" ON "agent_run" ("organization_id","id");
CREATE UNIQUE INDEX IF NOT EXISTS "message_organization_id_id_uq" ON "message" ("organization_id","id");
CREATE UNIQUE INDEX IF NOT EXISTS "agent_run_trace_uq" ON "agent_run" ("trace_id");
CREATE INDEX IF NOT EXISTS "agent_run_org_conversation_started_idx" ON "agent_run" ("organization_id","conversation_id","started_at");
CREATE INDEX IF NOT EXISTS "agent_run_org_status_started_idx" ON "agent_run" ("organization_id","status","started_at");

CREATE TABLE IF NOT EXISTS "agent_action_event" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "run_id" text NOT NULL REFERENCES "agent_run"("id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "success" boolean NOT NULL,
  "status" text NOT NULL,
  "entity_type" text,
  "entity_id" text,
  "outbound_message_id" text REFERENCES "message"("id") ON DELETE SET NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "agent_action_event_action_ck" CHECK ("action" IN ('reply','handoff','update_lead','move_stage','offer_slots','book_slot','reschedule_slot','cancel_booking','set_pending_book','set_pending_reschedule','set_pending_cancel'))
);
CREATE INDEX IF NOT EXISTS "agent_action_event_org_run_created_idx" ON "agent_action_event" ("organization_id","run_id","created_at");
CREATE INDEX IF NOT EXISTS "agent_action_event_org_action_created_idx" ON "agent_action_event" ("organization_id","action","created_at");

CREATE TABLE IF NOT EXISTS "agent_evidence" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "run_id" text NOT NULL REFERENCES "agent_run"("id") ON DELETE CASCADE,
  "source_type" text NOT NULL,
  "source_id" text,
  "snapshot" jsonb NOT NULL,
  "content_hash" text NOT NULL,
  "score" integer,
  "ordinal" integer NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "agent_evidence_source_type_ck" CHECK ("source_type" IN ('kb_entry','document_chunk','agenda','agent_profile','conversation_context')),
  CONSTRAINT "agent_evidence_ordinal_ck" CHECK ("ordinal" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "agent_evidence_org_run_ordinal_uq" ON "agent_evidence" ("organization_id","run_id","ordinal");
CREATE INDEX IF NOT EXISTS "agent_evidence_org_source_idx" ON "agent_evidence" ("organization_id","source_type","source_id");

ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_conversation_id_tenant_fk" FOREIGN KEY ("organization_id","conversation_id") REFERENCES "conversation"("organization_id","id") ON DELETE CASCADE;
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_inbound_message_id_tenant_fk" FOREIGN KEY ("organization_id","inbound_message_id") REFERENCES "message"("organization_id","id") ON DELETE SET NULL ("inbound_message_id");
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_outbound_message_id_tenant_fk" FOREIGN KEY ("organization_id","outbound_message_id") REFERENCES "message"("organization_id","id") ON DELETE SET NULL ("outbound_message_id");
ALTER TABLE "agent_action_event" ADD CONSTRAINT "agent_action_event_run_id_tenant_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "agent_run"("organization_id","id") ON DELETE CASCADE;
ALTER TABLE "agent_action_event" ADD CONSTRAINT "agent_action_event_outbound_message_id_tenant_fk" FOREIGN KEY ("organization_id","outbound_message_id") REFERENCES "message"("organization_id","id") ON DELETE SET NULL ("outbound_message_id");
ALTER TABLE "agent_evidence" ADD CONSTRAINT "agent_evidence_run_id_tenant_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "agent_run"("organization_id","id") ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS "agent_test_evidence_snapshot" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "test_case_id" text NOT NULL REFERENCES "agent_test_case"("id") ON DELETE CASCADE,
  "version" integer NOT NULL DEFAULT 1,
  "adjudication_version" integer NOT NULL DEFAULT 1,
  "evidence" jsonb NOT NULL,
  "evidence_digest" text NOT NULL,
  "judge_record" jsonb,
  "judge_input_digest" text,
  "verdict_digest" text,
  "status" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_test_evidence_snapshot_org_case_uq"
  ON "agent_test_evidence_snapshot" ("organization_id", "test_case_id");
CREATE INDEX IF NOT EXISTS "agent_test_evidence_snapshot_org_created_idx"
  ON "agent_test_evidence_snapshot" ("organization_id", "created_at");

-- Llave candidata del padre que exige la FK compuesta de abajo. La 0035 ya la
-- crea (agent_test_action_trace referencia agent_test_case), pero la migración
-- queda autosuficiente por si el orden de aplicación cambia.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_test_case_organization_id_id_uq"
  ON "agent_test_case" ("organization_id", "id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'agent_test_evidence_snapshot'::regclass
      AND conname = 'agent_test_evidence_snapshot_test_case_id_tenant_fk'
  ) THEN
    -- La tabla acaba de nacer y está vacía: la constraint se crea ya validada,
    -- así que el gate de release la acepta como respaldo compuesto real.
    ALTER TABLE "agent_test_evidence_snapshot"
      ADD CONSTRAINT "agent_test_evidence_snapshot_test_case_id_tenant_fk"
      FOREIGN KEY ("organization_id", "test_case_id")
      REFERENCES "agent_test_case" ("organization_id", "id")
      ON UPDATE NO ACTION ON DELETE CASCADE;
  END IF;
END $$;
