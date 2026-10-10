import { parseBody } from "@/lib/api";
import { isQuoteListFilter, listQuotesForCrm } from "@/server/quotes/crm";
import { crmCreateBodySchema, quotesCrmRoute } from "@/server/quotes/crm-http";
import { itemsToMilli, quotePayload } from "@/server/quotes/http";
import { createDraftQuote } from "@/server/quotes/service";

export const dynamic = "force-dynamic";

/** GET /api/quotes?filter=… — lista del negocio de la sesión. */
export const GET = quotesCrmRoute(["quotes.read"], async (session, req: Request) => {
  const raw = new URL(req.url).searchParams.get("filter");
  const rows = await listQuotesForCrm(session.organizationId, {
    filter: isQuoteListFilter(raw) ? raw : "todas",
  });
  return Response.json({
    quotes: rows.map((row) => ({
      ...row,
      validUntil: row.validUntil.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
  });
});

/** POST /api/quotes — borrador nuevo (precios del catálogo). */
export const POST = quotesCrmRoute(["quotes.manage"], async (session, req: Request) => {
  const body = await parseBody(req, crmCreateBodySchema);
  if (!body.ok) return body.response;
  const quote = await createDraftQuote({
    organizationId: session.organizationId,
    conversationId: body.data.conversationId,
    items: itemsToMilli(body.data.items),
    notes: body.data.notes ?? null,
    validityDays: body.data.validityDays,
    source: "manual",
    createdBy: session.userId,
  });
  return Response.json({ quote: quotePayload(quote) }, { status: 201 });
});
