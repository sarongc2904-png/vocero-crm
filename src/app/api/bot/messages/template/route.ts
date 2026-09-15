import { z } from "zod";
import { apiError, parseBody } from "@/lib/api";
import { authenticateBotRequest } from "@/server/bot/auth";
import { SendError } from "@/server/inbox/send";
import {
  sendTemplate,
  TemplateError,
  templateErrorStatus,
} from "@/server/whatsapp/templates";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversationId: z.string().min(1),
  templateId: z.string().min(1),
  variables: z.array(z.string().trim().max(500)).max(10).optional(),
});

/**
 * Envío de plantilla del cerebro externo A TRAVÉS del CRM — la contraparte de
 * `/api/bot/messages` (texto libre) para cuando la ventana de 24 h ya cerró.
 * Sin esto, un seguimiento proactivo a un lead inactivo (el caso de uso más
 * obvio de un cerebro externo) era imposible por esta superficie: WhatsApp
 * exige plantilla fuera de ventana y el bot no tenía forma de mandar una.
 *
 * Mismo camino (`sendTemplate`) y misma bitácora que usa el dueño desde la
 * bandeja: nadie manda una plantilla no aprobada ni con parámetros que no
 * cuadran, sin importar quién la pida.
 */
export async function POST(req: Request) {
  const auth = await authenticateBotRequest(req);
  if (!auth.ok) return auth.response;
  const organizationId = auth.organizationId;

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  try {
    const result = await sendTemplate({
      organizationId,
      conversationId: body.data.conversationId,
      templateId: body.data.templateId,
      variables: body.data.variables,
    });
    return Response.json({ messageId: result.messageId });
  } catch (err) {
    if (err instanceof TemplateError) {
      return apiError(templateErrorStatus(err), err.code, err.message);
    }
    if (err instanceof SendError) {
      return apiError(409, err.code, err.message);
    }
    throw err;
  }
}
