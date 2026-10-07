-- Envío de cotizaciones por WhatsApp (bandera COTIZACIONES).
--
-- Solo AGREGA: una tabla nueva y una columna nueva (nullable) en
-- quote_settings, que nació en 0037. Ninguna tabla previa a 0037 cambia.
--
-- quote_send es la bitácora de cada intento de envío. NO guarda el token del
-- enlace ni el texto del mensaje: solo referencias (enlace, mensaje) y el
-- resultado. Todas sus relaciones son FKs compuestas con organization_id.

ALTER TABLE "quote_settings" ADD COLUMN IF NOT EXISTS "whatsapp_template_id" text;

ALTER TABLE "quote_settings" ADD CONSTRAINT "quote_settings_whatsapp_template_id_tenant_fk"
  FOREIGN KEY ("organization_id", "whatsapp_template_id") REFERENCES "template"("organization_id", "id") ON DELETE SET NULL ("whatsapp_template_id");

CREATE TABLE IF NOT EXISTS "quote_send" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "quote_id" text NOT NULL,
  -- Clave que manda el navegador por intento: el mismo intento repetido
  -- (doble clic, reintento de red) devuelve el resultado guardado.
  "idempotency_key" text NOT NULL,
  -- 'pendiente' mientras se habla con Meta. 'incierto' NO se guarda: se
  -- calcula al leer (pendiente con más de 5 minutos) y lo resuelve el
  -- operador ("Sí llegó" / "No llegó").
  "status" text NOT NULL DEFAULT 'pendiente',
  "mode" text,
  "template_id" text,
  "quote_link_id" text,
  "message_id" text,
  "wa_message_id" text,
  "sent_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "error_code" text,
  -- Quién resolvió un intento incierto y cómo ('llego' / 'no_llego').
  "resolved_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "resolution" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "completed_at" timestamp,
  CONSTRAINT "quote_send_status_ck" CHECK ("status" IN ('pendiente', 'enviado', 'fallido')),
  CONSTRAINT "quote_send_mode_ck" CHECK ("mode" IS NULL OR "mode" IN ('documento', 'plantilla')),
  CONSTRAINT "quote_send_resolution_ck" CHECK ("resolution" IS NULL OR "resolution" IN ('llego', 'no_llego')),
  CONSTRAINT "quote_send_key_ck" CHECK (char_length("idempotency_key") BETWEEN 8 AND 100),
  CONSTRAINT "quote_send_completed_ck" CHECK (("status" = 'pendiente') = ("completed_at" IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "quote_send_organization_id_id_uq" ON "quote_send" ("organization_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "quote_send_org_key_uq" ON "quote_send" ("organization_id", "idempotency_key");
-- Un solo intento en curso por cotización: el segundo choca aquí.
CREATE UNIQUE INDEX IF NOT EXISTS "quote_send_one_pending_uq" ON "quote_send" ("organization_id", "quote_id") WHERE "status" = 'pendiente';
CREATE INDEX IF NOT EXISTS "quote_send_org_created_idx" ON "quote_send" ("organization_id", "created_at");

-- Llave candidata para la FK compuesta hacia quote_link (0037 no la creó).
CREATE UNIQUE INDEX IF NOT EXISTS "quote_link_organization_id_id_uq" ON "quote_link" ("organization_id", "id");

ALTER TABLE "quote_send" ADD CONSTRAINT "quote_send_quote_id_tenant_fk"
  FOREIGN KEY ("organization_id", "quote_id") REFERENCES "quote"("organization_id", "id") ON DELETE CASCADE;
ALTER TABLE "quote_send" ADD CONSTRAINT "quote_send_template_id_tenant_fk"
  FOREIGN KEY ("organization_id", "template_id") REFERENCES "template"("organization_id", "id") ON DELETE SET NULL ("template_id");
ALTER TABLE "quote_send" ADD CONSTRAINT "quote_send_quote_link_id_tenant_fk"
  FOREIGN KEY ("organization_id", "quote_link_id") REFERENCES "quote_link"("organization_id", "id") ON DELETE SET NULL ("quote_link_id");
ALTER TABLE "quote_send" ADD CONSTRAINT "quote_send_message_id_tenant_fk"
  FOREIGN KEY ("organization_id", "message_id") REFERENCES "message"("organization_id", "id") ON DELETE SET NULL ("message_id");
