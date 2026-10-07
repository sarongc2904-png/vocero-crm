import { parseBody } from "@/lib/api";
import { guardQuotesBot } from "@/server/quotes/bot-guard";
import {
  createQuoteBodySchema,
  itemsToMilli,
  quoteErrorResponse,
  quotePayload,
} from "@/server/quotes/http";
import { createDraftQuote, listQuotes } from "@/server/quotes/service";

export const dynamic = "force-dynamic";

/**
 * create_quote para un cerebro externo.
 *
 * POST /api/bot/quotes → 201 con la cotización en `borrador`.
 *   { conversationId, items: [{ serviceId, quantity? }], notes?, validityDays? }
 * El body NO acepta montos: el precio de cada línea sale del catálogo y los
 * totales los calcula el servidor. En esta etapa solo se crean borradores;
 * enviarla al cliente es otra operación (aún no expuesta).
 *
 * GET /api/bot/quotes?conversationId=…&limit=… → cotizaciones del negocio.
 */
export async function POST(req: Request) {
  const gate = await guardQuotesBot(req);
  if ("response" in gate) return gate.response;

  const body = await parseBody(req, createQuoteBodySchema);
  if (!body.ok) return body.response;

  try {
    const quote = await createDraftQuote({
      organizationId: gate.organizationId,
      conversationId: body.data.conversationId,
      items: itemsToMilli(body.data.items),
      notes: body.data.notes ?? null,
      validityDays: body.data.validityDays,
      source: "bot",
    });
    return Response.json({ quote: quotePayload(quote) }, { status: 201 });
  } catch (err) {
    return quoteErrorResponse(err);
  }
}

export async function GET(req: Request) {
  const gate = await guardQuotesBot(req);
  if ("response" in gate) return gate.response;

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId") ?? undefined;
  const rawLimit = Number(url.searchParams.get("limit") ?? 20);

  try {
    const quotes = await listQuotes(gate.organizationId, {
      conversationId,
      limit: Number.isFinite(rawLimit) ? rawLimit : 20,
    });
    return Response.json({ quotes: quotes.map(quotePayload) });
  } catch (err) {
    return quoteErrorResponse(err);
  }
}
