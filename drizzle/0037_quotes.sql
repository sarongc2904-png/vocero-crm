-- Cotizaciones (módulo opcional detrás de la bandera COTIZACIONES).
--
-- Solo AGREGA tablas: ninguna tabla, columna ni restricción existente cambia.
-- Como toda migración, se aplica aunque la bandera esté apagada; unas tablas
-- vacías son inertes.
--
-- Aislamiento por negocio a nivel PostgreSQL, con el mismo patrón de la 0035:
-- cada relación con otra tabla de dominio es una FK COMPUESTA
-- (organization_id, x_id), así que una fila jamás puede apuntar a una fila de
-- otro negocio aunque el código se equivoque.
--
-- Dinero en centavos enteros (bigint: una cotización de obra puede pasar de
-- los ~21 millones que caben en integer). La cantidad va en milésimas para
-- permitir 1.5 m², 0.25 kg, etc. sin coma flotante.

CREATE TABLE IF NOT EXISTS "quote_settings" (
  "organization_id" text PRIMARY KEY NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "prices_include_tax" boolean NOT NULL DEFAULT false,
  "tax_rate_bps" integer NOT NULL DEFAULT 1600,
  "default_validity_days" integer NOT NULL DEFAULT 15,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "quote_settings_tax_rate_ck" CHECK ("tax_rate_bps" BETWEEN 0 AND 10000),
  CONSTRAINT "quote_settings_validity_ck" CHECK ("default_validity_days" BETWEEN 1 AND 365)
);

-- Folio consecutivo POR NEGOCIO (COT-0001…). Se toma con
-- INSERT … ON CONFLICT DO UPDATE … RETURNING dentro de la transacción que crea
-- la cotización: dos altas simultáneas jamás reciben el mismo número.
CREATE TABLE IF NOT EXISTS "quote_counter" (
  "organization_id" text PRIMARY KEY NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "last_number" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "quote_counter_last_number_ck" CHECK ("last_number" >= 0)
);

CREATE TABLE IF NOT EXISTS "quote" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "contact_id" text NOT NULL,
  "conversation_id" text,
  "lead_id" text,
  "number" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'borrador',
  "currency" text NOT NULL DEFAULT 'MXN',
  -- Copiados de quote_settings al crear: cambiar la configuración no reescribe
  -- cotizaciones ya emitidas.
  "prices_include_tax" boolean NOT NULL,
  "tax_rate_bps" integer NOT NULL,
  "subtotal_cents" bigint NOT NULL DEFAULT 0,
  "tax_cents" bigint NOT NULL DEFAULT 0,
  "total_cents" bigint NOT NULL DEFAULT 0,
  "valid_until" timestamp NOT NULL,
  "notes" text,
  "source" text NOT NULL DEFAULT 'manual',
  "is_test" boolean NOT NULL DEFAULT false,
  "created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "sent_at" timestamp,
  "responded_at" timestamp,
  "response_note" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "quote_status_ck" CHECK ("status" IN ('borrador', 'enviada', 'aceptada', 'rechazada', 'expirada', 'cancelada')),
  CONSTRAINT "quote_source_ck" CHECK ("source" IN ('manual', 'bot', 'ai')),
  CONSTRAINT "quote_number_ck" CHECK ("number" > 0),
  CONSTRAINT "quote_tax_rate_ck" CHECK ("tax_rate_bps" BETWEEN 0 AND 10000),
  CONSTRAINT "quote_amounts_ck" CHECK ("subtotal_cents" >= 0 AND "tax_cents" >= 0 AND "total_cents" >= 0),
  -- Invariante de totales: con precios con IVA el total ES el subtotal (el
  -- IVA va desglosado dentro); sin IVA incluido, el IVA se suma encima.
  CONSTRAINT "quote_total_ck" CHECK (
    "total_cents" = CASE WHEN "prices_include_tax" THEN "subtotal_cents" ELSE "subtotal_cents" + "tax_cents" END
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "quote_organization_id_id_uq" ON "quote" ("organization_id", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "quote_org_number_uq" ON "quote" ("organization_id", "number");
CREATE INDEX IF NOT EXISTS "quote_org_status_idx" ON "quote" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "quote_org_created_idx" ON "quote" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "quote_org_contact_idx" ON "quote" ("organization_id", "contact_id");

ALTER TABLE "quote" ADD CONSTRAINT "quote_contact_id_tenant_fk"
  FOREIGN KEY ("organization_id", "contact_id") REFERENCES "contact"("organization_id", "id") ON DELETE CASCADE;
ALTER TABLE "quote" ADD CONSTRAINT "quote_conversation_id_tenant_fk"
  FOREIGN KEY ("organization_id", "conversation_id") REFERENCES "conversation"("organization_id", "id") ON DELETE SET NULL ("conversation_id");
ALTER TABLE "quote" ADD CONSTRAINT "quote_lead_id_tenant_fk"
  FOREIGN KEY ("organization_id", "lead_id") REFERENCES "lead"("organization_id", "id") ON DELETE SET NULL ("lead_id");

CREATE TABLE IF NOT EXISTS "quote_item" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "quote_id" text NOT NULL,
  -- Solo referencia al catálogo: descripción y precio se COPIAN en la línea,
  -- así cambiar o borrar el servicio no altera una cotización emitida.
  "service_id" text,
  "position" integer NOT NULL,
  "description" text NOT NULL,
  "quantity_milli" integer NOT NULL,
  "unit_price_cents" bigint NOT NULL,
  "line_total_cents" bigint NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "quote_item_position_ck" CHECK ("position" >= 0),
  CONSTRAINT "quote_item_description_ck" CHECK (char_length("description") BETWEEN 1 AND 500),
  CONSTRAINT "quote_item_quantity_ck" CHECK ("quantity_milli" > 0),
  CONSTRAINT "quote_item_amounts_ck" CHECK ("unit_price_cents" >= 0 AND "line_total_cents" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "quote_item_org_quote_position_uq" ON "quote_item" ("organization_id", "quote_id", "position");

ALTER TABLE "quote_item" ADD CONSTRAINT "quote_item_quote_id_tenant_fk"
  FOREIGN KEY ("organization_id", "quote_id") REFERENCES "quote"("organization_id", "id") ON DELETE CASCADE;
ALTER TABLE "quote_item" ADD CONSTRAINT "quote_item_service_id_tenant_fk"
  FOREIGN KEY ("organization_id", "service_id") REFERENCES "service"("organization_id", "id") ON DELETE SET NULL ("service_id");

-- Enlace público /p/[token]. Solo se guarda el SHA-256 del token: un respaldo
-- o una fuga de la base no entrega enlaces válidos.
CREATE TABLE IF NOT EXISTS "quote_link" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "quote_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "revoked_at" timestamp,
  "last_viewed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "quote_link_token_hash_ck" CHECK ("token_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "quote_link_token_hash_uq" ON "quote_link" ("token_hash");
CREATE INDEX IF NOT EXISTS "quote_link_org_quote_idx" ON "quote_link" ("organization_id", "quote_id");

ALTER TABLE "quote_link" ADD CONSTRAINT "quote_link_quote_id_tenant_fk"
  FOREIGN KEY ("organization_id", "quote_id") REFERENCES "quote"("organization_id", "id") ON DELETE CASCADE;
