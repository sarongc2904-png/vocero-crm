import { apiError, parseBody } from "@/lib/api";
import { getQuoteDetailForCrm } from "@/server/quotes/crm";
import { crmDetailPayload, crmEditBodySchema, quotesCrmRoute } from "@/server/quotes/crm-http";
import { itemsToMilli, quotePayload } from "@/server/quotes/http";
import { updateDraftQuote } from "@/server/quotes/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/quotes/:id — detalle; la de otro negocio es 404. */
export const GET = quotesCrmRoute(["quotes.read"], async (session, _req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const detail = await getQuoteDetailForCrm(session.organizationId, id);
  if (!detail) return apiError(404, "not_found", "Cotización no encontrada");
  return Response.json(crmDetailPayload(detail));
});

/** PATCH /api/quotes/:id — edita un BORRADOR (409 en cualquier otro estado). */
export const PATCH = quotesCrmRoute(["quotes.manage"], async (session, req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, crmEditBodySchema);
  if (!body.ok) return body.response;
  const quote = await updateDraftQuote({
    organizationId: session.organizationId,
    quoteId: id,
    items: itemsToMilli(body.data.items),
    notes: body.data.notes ?? null,
    validityDays: body.data.validityDays,
  });
  return Response.json({ quote: quotePayload(quote) });
});
