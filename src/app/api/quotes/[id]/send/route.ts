import { quotesCrmRoute } from "@/server/quotes/crm-http";
import { sendViewPayload, quoteSendErrorResponse } from "@/server/quotes/send-http";
import { sendQuoteByWhatsApp } from "@/server/quotes/whatsapp-send";

export const dynamic = "force-dynamic";

/**
 * POST /api/quotes/:id/send — "Enviar por WhatsApp" (solo `quotes.publish`).
 *
 * Exige `Idempotency-Key`: el navegador genera una por clic; repetirla no
 * vuelve a enviar. Respuestas:
 *   200 enviado · 202 aún en curso · 502 Meta lo rechazó (cotización sigue en
 *   borrador) · 409 en curso / sin confirmar / ya no es borrador ·
 *   422 Laboratorio, sin plantilla, sin número · 429 límite del negocio.
 */
export const POST = quotesCrmRoute(
  ["quotes.publish"],
  async (session, req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    try {
      const send = await sendQuoteByWhatsApp({
        organizationId: session.organizationId,
        quoteId: id,
        userId: session.userId,
        idempotencyKey: req.headers.get("idempotency-key") ?? "",
      });
      const status = send.status === "enviado" ? 200 : send.status === "fallido" ? 502 : 202;
      return Response.json({ send: sendViewPayload(send) }, { status, headers: { "cache-control": "no-store" } });
    } catch (err) {
      return quoteSendErrorResponse(err);
    }
  }
);
