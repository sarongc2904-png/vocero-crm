import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { serializeTemplate } from "@/server/whatsapp/templates";

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
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

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
