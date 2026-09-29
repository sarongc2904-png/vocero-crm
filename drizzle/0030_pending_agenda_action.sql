-- IA-1 / IA-W1 / IA-W2 — Estado explícito de CONFIRMACIÓN PENDIENTE.
--
-- La cancelación era destructiva y se disparaba desde un regex: "¿Puedo cancelar
-- mi cita?" cancelaba la cita de verdad. Y seleccionar un horario no dejaba
-- rastro, así que repetir "10:20" volvía a preguntar lo mismo sin avanzar.
--
-- Esta tabla guarda UNA acción pendiente por conversación (la última gana) con
-- su objetivo y su expiración. Una confirmación sin fila vigente no ejecuta
-- nada: el estado es del backend, nunca del modelo.
--
-- Tenant-safe por construcción: `organization_id` es NOT NULL y el índice único
-- es por CONVERSACIÓN, así que dos tenants jamás comparten fila.
CREATE TABLE IF NOT EXISTS "pending_agenda_action" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "conversation_id" text NOT NULL REFERENCES "conversation"("id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "booking_id" text REFERENCES "booking"("id") ON DELETE CASCADE,
  "start_utc" timestamp,
  "service_id" text REFERENCES "service"("id") ON DELETE SET NULL,
  "professional_id" text REFERENCES "professional"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "expires_at" timestamp NOT NULL,
  CONSTRAINT "pending_agenda_action_kind_chk"
    CHECK ("action" IN ('book', 'reschedule', 'cancel'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "pending_agenda_action_conversation_uq"
  ON "pending_agenda_action" ("conversation_id");

CREATE INDEX IF NOT EXISTS "pending_agenda_action_expiry_idx"
  ON "pending_agenda_action" ("expires_at");
