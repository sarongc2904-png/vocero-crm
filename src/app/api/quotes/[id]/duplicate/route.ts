import { quotesCrmRoute } from "@/server/quotes/crm-http";
import { quotePayload } from "@/server/quotes/http";
import { duplicateQuote } from "@/server/quotes/transitions";

export const dynamic = "force-dynamic";

/**
 * POST /api/quotes/:id/duplicate — corrige una cotización ya no editable:
 * copia sus líneas a un borrador nuevo y, si estaba enviada, la cancela.
 *
 * Pide `quotes.manage` Y `quotes.publish`: cancelar una enviada retira algo
 * que el cliente ya tiene, así que un agente no puede hacerlo solo.
 */
export const POST = quotesCrmRoute(
  ["quotes.manage", "quotes.publish"],
  async (session, _req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const { original, copy } = await duplicateQuote({
      organizationId: session.organizationId,
      quoteId: id,
      userId: session.userId,
    });
    return Response.json({ original: quotePayload(original), copy: quotePayload(copy) }, { status: 201 });
  }
);
