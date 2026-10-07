import { z } from "zod";
import { parseBody } from "@/lib/api";
import { quotesCrmRoute } from "@/server/quotes/crm-http";
import { quoteSendErrorResponse, sendViewPayload } from "@/server/quotes/send-http";
import { resolveUncertainSend } from "@/server/quotes/whatsapp-send";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ outcome: z.enum(["llego", "no_llego"]) }).strict();

/**
 * POST /api/quotes/:id/send/:sendId/resolve — el operador resuelve un envío
 * que quedó sin confirmar: "Sí llegó" (queda enviada) o "No llegó" (se puede
 * reintentar). Nunca se reenvía nada automáticamente.
 */
export const POST = quotesCrmRoute(
  ["quotes.publish"],
  async (session, req: Request, ctx: { params: Promise<{ id: string; sendId: string }> }) => {
    const { id, sendId } = await ctx.params;
    const body = await parseBody(req, bodySchema);
    if (!body.ok) return body.response;
    try {
      const send = await resolveUncertainSend({
        organizationId: session.organizationId,
        quoteId: id,
        sendId,
        userId: session.userId,
        outcome: body.data.outcome,
      });
      return Response.json({ send: sendViewPayload(send) });
    } catch (err) {
      return quoteSendErrorResponse(err);
    }
  }
);
