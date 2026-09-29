-- IA-3 — Cursor de expansión de disponibilidad ("otros horarios").
--
-- `windowSlots(..., "next_day")` devolvía siempre `days[1]`: pedir "otros
-- horarios" dos veces mostraba el MISMO bloque, y tras ver "el viernes" podía
-- retroceder a un día anterior. El cursor no se puede derivar de `offered_slot`
-- porque esa tabla persiste el catálogo COMPLETO, no la ventana presentada, así
-- que hace falta un estado mínimo explícito.
--
-- Una fila por conversación. `mode` distingue el criterio para que cambiar de
-- "otros horarios" a "más tarde"/"fin de semana" reinicie la ventana de forma
-- determinista en vez de arrastrar el cursor anterior. `expires_at` evita que
-- un cursor viejo gobierne una conversación retomada días después.
CREATE TABLE IF NOT EXISTS "agenda_offer_cursor" (
  "conversation_id" text PRIMARY KEY REFERENCES "conversation"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "mode" text NOT NULL DEFAULT 'next_day',
  "cursor" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "expires_at" timestamp NOT NULL,
  CONSTRAINT "agenda_offer_cursor_mode_chk"
    CHECK ("mode" IN ('next_day', 'morning', 'afternoon', 'weekend'))
);

CREATE INDEX IF NOT EXISTS "agenda_offer_cursor_expiry_idx"
  ON "agenda_offer_cursor" ("expires_at");
