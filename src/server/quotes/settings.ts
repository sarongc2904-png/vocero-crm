import { asc, eq } from "drizzle-orm";
import { scoped } from "@/lib/db/tenant";
import { countVariables } from "@/lib/templates";
import { getDb, schema } from "@/lib/db";

/**
 * Configuración de cotizaciones de un negocio: una fila por organización
 * (`organization_id` es la llave primaria de `quote_settings`).
 *
 * Un negocio sin fila usa estos valores. `pricesIncludeTax: false` es el
 * default seguro: el IVA se SUMA al precio del catálogo, así una cotización
 * nunca cobra de menos por suponer que el precio ya lo traía. Quien maneja
 * precios con IVA incluido lo enciende explícitamente.
 */
export type QuoteSettings = {
  pricesIncludeTax: boolean;
  /** Puntos base: 1600 = 16 %. */
  taxRateBps: number;
  defaultValidityDays: number;
  /** 0038 — plantilla para enviar fuera de la ventana de 24 h; null = no hay. */
  whatsappTemplateId: string | null;
};

export const DEFAULT_QUOTE_SETTINGS: Readonly<QuoteSettings> = Object.freeze({
  pricesIncludeTax: false,
  taxRateBps: 1600,
  defaultValidityDays: 15,
  whatsappTemplateId: null,
});

type Reader = Pick<ReturnType<typeof getDb>, "select">;

export async function getQuoteSettings(
  organizationId: string,
  db: Reader = getDb()
): Promise<QuoteSettings> {
  if (!organizationId) throw new Error("getQuoteSettings(): organizationId vacío");
  const rows = await db
    .select({
      pricesIncludeTax: schema.quoteSettings.pricesIncludeTax,
      taxRateBps: schema.quoteSettings.taxRateBps,
      defaultValidityDays: schema.quoteSettings.defaultValidityDays,
      whatsappTemplateId: schema.quoteSettings.whatsappTemplateId,
    })
    .from(schema.quoteSettings)
    .where(eq(schema.quoteSettings.organizationId, organizationId))
    .limit(1);
  return rows[0] ?? { ...DEFAULT_QUOTE_SETTINGS };
}

export class QuoteSettingsError extends Error {
  readonly code = "invalid" as const;
  constructor(message: string) {
    super(message);
    this.name = "QuoteSettingsError";
  }
}

export type QuoteTemplateOption = {
  id: string;
  name: string;
  language: string;
  category: string;
  body: string;
  status: string;
  /** Aprobada y con exactamente {{1}} nombre, {{2}} folio, {{3}} enlace. */
  eligible: boolean;
  reason: string | null;
};

/** Plantillas del negocio y si sirven para enviar cotizaciones. */
export async function listQuoteTemplateOptions(organizationId: string): Promise<QuoteTemplateOption[]> {
  const rows = await getDb()
    .select({
      id: schema.template.id,
      name: schema.template.name,
      language: schema.template.language,
      category: schema.template.category,
      body: schema.template.body,
      status: schema.template.status,
    })
    .from(schema.template)
    .where(scoped(schema.template.organizationId, organizationId))
    .orderBy(asc(schema.template.name));
  return rows.map((row) => {
    const vars = countVariables(row.body);
    const reason =
      row.status !== "approved"
        ? "Aún no está aprobada por Meta"
        : vars !== 3
          ? `Tiene ${vars} variable(s); necesita exactamente 3: {{1}} nombre, {{2}} folio, {{3}} enlace`
          : null;
    return { ...row, eligible: reason === null, reason };
  });
}

/** Porcentaje con hasta 2 decimales (16, 8.5, 0) → puntos base. */
export function percentToBps(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new QuoteSettingsError("El IVA debe estar entre 0 y 100 %");
  }
  const bps = Math.round(percent * 100);
  if (Math.abs(percent * 100 - bps) > 1e-6) {
    throw new QuoteSettingsError("El IVA admite como máximo 2 decimales");
  }
  return bps;
}

/**
 * Guarda la configuración del negocio (una fila por organización). La
 * plantilla, si se elige, debe ser DE ESTE negocio, estar aprobada y tener
 * exactamente 3 variables. Cambiarla no altera cotizaciones ya emitidas.
 */
export async function saveQuoteSettings(
  organizationId: string,
  input: { pricesIncludeTax: boolean; taxRatePercent: number; defaultValidityDays: number; whatsappTemplateId: string | null }
): Promise<QuoteSettings> {
  if (!organizationId) throw new Error("saveQuoteSettings(): organizationId vacío");
  const taxRateBps = percentToBps(input.taxRatePercent);
  if (!Number.isInteger(input.defaultValidityDays) || input.defaultValidityDays < 1 || input.defaultValidityDays > 365) {
    throw new QuoteSettingsError("La vigencia debe estar entre 1 y 365 días");
  }
  if (input.whatsappTemplateId) {
    const options = await listQuoteTemplateOptions(organizationId);
    const chosen = options.find((t) => t.id === input.whatsappTemplateId);
    // Ajena o inexistente: mismo mensaje.
    if (!chosen) throw new QuoteSettingsError("Esa plantilla no existe en este negocio");
    if (!chosen.eligible) throw new QuoteSettingsError(`La plantilla "${chosen.name}" no sirve: ${chosen.reason}`);
  }
  const values = {
    pricesIncludeTax: input.pricesIncludeTax,
    taxRateBps,
    defaultValidityDays: input.defaultValidityDays,
    whatsappTemplateId: input.whatsappTemplateId,
    updatedAt: new Date(),
  };
  await getDb()
    .insert(schema.quoteSettings)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({ target: schema.quoteSettings.organizationId, set: values });
  return getQuoteSettings(organizationId);
}
