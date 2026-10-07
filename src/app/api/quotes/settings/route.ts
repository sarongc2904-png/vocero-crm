import { z } from "zod";
import { parseBody } from "@/lib/api";
import { quotesCrmRoute } from "@/server/quotes/crm-http";
import {
  getQuoteSettings,
  listQuoteTemplateOptions,
  QuoteSettingsError,
  saveQuoteSettings,
  type QuoteSettings,
} from "@/server/quotes/settings";

export const dynamic = "force-dynamic";

function payload(settings: QuoteSettings) {
  return {
    pricesIncludeTax: settings.pricesIncludeTax,
    taxRatePercent: settings.taxRateBps / 100,
    defaultValidityDays: settings.defaultValidityDays,
    whatsappTemplateId: settings.whatsappTemplateId,
  };
}

/** GET /api/quotes/settings — configuración y plantillas elegibles. */
export const GET = quotesCrmRoute(["quotes.read"], async (session) => {
  const [settings, templates] = await Promise.all([
    getQuoteSettings(session.organizationId),
    listQuoteTemplateOptions(session.organizationId),
  ]);
  return Response.json({ settings: payload(settings), templates });
});

const bodySchema = z
  .object({
    pricesIncludeTax: z.boolean(),
    taxRatePercent: z.number().min(0).max(100),
    defaultValidityDays: z.number().int().min(1).max(365),
    whatsappTemplateId: z.string().min(1).max(100).nullable(),
  })
  .strict();

/** PUT /api/quotes/settings — solo owner y admin (`settings.update`). */
export const PUT = quotesCrmRoute(["settings.update"], async (session, req: Request) => {
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;
  try {
    const saved = await saveQuoteSettings(session.organizationId, body.data);
    return Response.json({ settings: payload(saved) });
  } catch (err) {
    if (err instanceof QuoteSettingsError) {
      return Response.json({ error: { code: "invalid_body", message: err.message } }, { status: 422 });
    }
    throw err;
  }
});
