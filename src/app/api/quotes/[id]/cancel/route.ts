import { quotesCrmRoute } from "@/server/quotes/crm-http";
import { quotePayload } from "@/server/quotes/http";
import { cancelQuote } from "@/server/quotes/transitions";

export const dynamic = "force-dynamic";

/** POST /api/quotes/:id/cancel — borrador o enviada → cancelada; revoca el enlace. */
export const POST = quotesCrmRoute(
  ["quotes.publish"],
  async (session, _req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const quote = await cancelQuote({ organizationId: session.organizationId, quoteId: id });
    return Response.json({ quote: quotePayload(quote) });
  }
);
