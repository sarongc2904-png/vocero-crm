import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { guardQuotesBot } from "@/server/quotes/bot-guard";
import { getQuoteSettings } from "@/server/quotes/settings";

export const dynamic = "force-dynamic";

/**
 * GET /api/bot/catalog — get_products para un cerebro externo.
 *
 * Solo los servicios ACTIVOS del negocio dueño de la API key, con su precio
 * en centavos y la configuración de IVA con la que se cotizará. Es de solo
 * lectura: para cotizar se manda el `id` a `POST /api/bot/quotes`, y el
 * precio se vuelve a leer de la base en ese momento.
 */
export async function GET(req: Request) {
  const gate = await guardQuotesBot(req);
  if ("response" in gate) return gate.response;
  const { organizationId } = gate;

  const services = await getDb()
    .select({
      id: schema.service.id,
      name: schema.service.name,
      description: schema.service.description,
      category: schema.service.category,
      priceCents: schema.service.priceCents,
      currency: schema.service.currency,
    })
    .from(schema.service)
    .where(scoped(schema.service.organizationId, organizationId, eq(schema.service.active, true)))
    .orderBy(asc(schema.service.name));

  const settings = await getQuoteSettings(organizationId);

  return Response.json({
    services,
    tax: {
      pricesIncludeTax: settings.pricesIncludeTax,
      taxRateBps: settings.taxRateBps,
    },
    defaultValidityDays: settings.defaultValidityDays,
  });
}
