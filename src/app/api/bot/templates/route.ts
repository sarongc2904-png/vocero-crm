import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { authenticateBotRequest } from "@/server/bot/auth";
import {
  createTemplate,
  TemplateError,
  templateErrorStatus,
  serializeTemplate,
} from "@/server/whatsapp/templates";

export const dynamic = "force-dynamic";

/**
 * Plantillas APROBADAS disponibles para un cerebro externo — sin esto, la
 * única forma de que n8n supiera qué `templateId` mandar a `POST
 * /api/bot/messages/template` sería consultando la base de datos a mano.
 *
 * Solo aprobadas: mandar una `pending` o `rejected` fallaría en Meta, y este
 * endpoint es justo para que el cerebro externo no tenga que adivinar cuál
 * sirve.
 */
export async function GET(req: Request) {
  const auth = await authenticateBotRequest(req);
  if (!auth.ok) return auth.response;
  const organizationId = auth.organizationId;

  const db = getDb();
  const rows = await db
    .select()
    .from(schema.template)
    .where(eq(schema.template.organizationId, organizationId))
    .orderBy(asc(schema.template.createdAt));

  return Response.json({
    templates: rows
      .filter((t) => t.status === "approved")
      .map((t) => serializeTemplate(t)),
  });
}

const postBodySchema = z.object({
  name: z.string().min(1).max(60),
  language: z.string().min(2).max(10),
  category: z.string().min(1),
  body: z.string().min(1).max(1024),
});

/**
 * Crea una plantilla y la manda a aprobación de Meta. Queda `pending` hasta
 * que Meta resuelva — `GET` de arriba solo devuelve las ya `approved`, así
 * que el cerebro externo sabe cuándo puede usarla sin tener que adivinar el
 * tiempo de revisión.
 */
export async function POST(req: Request) {
  const auth = await authenticateBotRequest(req);
  if (!auth.ok) return auth.response;
  const organizationId = auth.organizationId;

  const body = await parseBody(req, postBodySchema);
  if (!body.ok) return body.response;

  try {
    const template = await createTemplate(organizationId, body.data);
    return Response.json(serializeTemplate(template));
  } catch (err) {
    if (err instanceof TemplateError) {
      return apiError(templateErrorStatus(err), err.code, err.message);
    }
    throw err;
  }
}
