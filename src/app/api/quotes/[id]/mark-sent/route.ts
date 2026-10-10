import { quotesCrmRoute } from "@/server/quotes/crm-http";
import { quotePayload } from "@/server/quotes/http";
import { markQuoteSent } from "@/server/quotes/transitions";

export const dynamic = "force-dynamic";

/**
 * POST /api/quotes/:id/mark-sent — "ya le compartí el enlace por otro medio".
 * Borrador → enviada; exige un enlace vivo y vigencia futura (409 si no).
 */
export const POST = quotesCrmRoute(
  ["quotes.publish"],
  async (session, _req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const quote = await markQuoteSent({ organizationId: session.organizationId, quoteId: id, userId: session.userId });
    return Response.json({ quote: quotePayload(quote) });
  }
);
