import { eq } from "drizzle-orm";
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
