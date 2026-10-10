import { apiError } from "@/lib/api";
import { guardQuotesBot } from "@/server/quotes/bot-guard";
import { quotePayload } from "@/server/quotes/http";
import { getQuote } from "@/server/quotes/service";

export const dynamic = "force-dynamic";

/** GET /api/bot/quotes/:id — una cotización del negocio; la de otro es 404. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardQuotesBot(req);
  if ("response" in gate) return gate.response;

  const { id } = await ctx.params;
  const quote = await getQuote(gate.organizationId, id);
  if (!quote) return apiError(404, "not_found", "Cotización no encontrada");
  return Response.json({ quote: quotePayload(quote) });
}
