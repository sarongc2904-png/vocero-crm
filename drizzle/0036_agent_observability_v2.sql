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
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
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
