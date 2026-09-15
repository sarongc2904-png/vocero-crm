import { and, asc, eq, lt, ne } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { serializeFicha } from "@/server/bot/ficha";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Leads para que un cerebro externo (n8n, un scheduler propio) decida a quién
 * darle seguimiento y con qué — la contraparte de lectura de `/api/bot/messages`
 * y `/api/bot/ficha`.
 *
 * GET /api/bot/leads
 *   ?stageName=...          filtra por el nombre EXACTO de una etapa
 *   ?inactiveSinceMinutes=  solo leads cuya conversación no se mueve hace
 *                           al menos N minutos (ver lastMessageAt)
 *   ?includeClosed=true     incluye también etapas "won"/"lost" (por defecto
 *                           solo las abiertas: no tiene sentido dar
 *                           seguimiento a un trato ya cerrado)
 *   ?limit=                 1..200, default 50
 *
 * Solo lectura, y JAMÁS incluye conversaciones del Laboratorio (`isTest`):
 * una simulación no es un lead real al que perseguir.
 */
export async function GET(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const url = new URL(req.url);
  const stageName = url.searchParams.get("stageName");
  const includeClosed = url.searchParams.get("includeClosed") === "true";
  const inactiveSinceMinutes = url.searchParams.get("inactiveSinceMinutes");
  const rawLimit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const db = getDb();
  const conditions = [
    eq(schema.lead.organizationId, organizationId),
    eq(schema.conversation.isTest, false),
  ];
  if (!includeClosed) conditions.push(ne(schema.pipelineStage.kind, "won"), ne(schema.pipelineStage.kind, "lost"));
  if (stageName) conditions.push(eq(schema.pipelineStage.name, stageName));
  if (inactiveSinceMinutes) {
    const minutes = Number(inactiveSinceMinutes);
    if (Number.isFinite(minutes) && minutes > 0) {
      const cutoff = new Date(Date.now() - minutes * 60_000);
      conditions.push(lt(schema.conversation.lastMessageAt, cutoff));
    }
  }

  const rows = await db
    .select({
      lead: schema.lead,
      contact: schema.contact,
      conversation: schema.conversation,
      stage: schema.pipelineStage,
    })
    .from(schema.lead)
    .innerJoin(schema.contact, eq(schema.lead.contactId, schema.contact.id))
    .innerJoin(
      schema.conversation,
      and(
        eq(schema.conversation.contactId, schema.contact.id),
        eq(schema.conversation.organizationId, schema.lead.organizationId)
      )
    )
    .innerJoin(schema.pipelineStage, eq(schema.lead.stageId, schema.pipelineStage.id))
    .where(and(...conditions))
    .orderBy(asc(schema.conversation.lastMessageAt))
    .limit(limit);

  return Response.json({
    leads: rows.map((r) => ({
      leadId: r.lead.id,
      conversationId: r.conversation.id,
      contactId: r.contact.id,
      name: r.contact.name,
      identity: r.contact.waIdentity,
      phone: r.contact.phone,
      channel: r.contact.channel,
      ficha: serializeFicha(r.contact),
      stage: { id: r.stage.id, name: r.stage.name, kind: r.stage.kind },
      amountCents: r.lead.amountCents,
      aiEnabled: r.conversation.aiEnabled && !r.conversation.handoffAt,
      handoffAt: r.conversation.handoffAt?.toISOString() ?? null,
      lastInboundAt: r.conversation.lastInboundAt?.toISOString() ?? null,
      lastMessageAt: r.conversation.lastMessageAt?.toISOString() ?? null,
      createdAt: r.lead.createdAt.toISOString(),
    })),
  });
}
