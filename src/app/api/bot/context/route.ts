import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { authenticateBotRequest } from "@/server/bot/auth";
import { serializeFicha } from "@/server/bot/ficha";
import { isWindowOpen, windowRemainingMs } from "@/server/inbox/window";

export const dynamic = "force-dynamic";

/**
 * Contexto conversacional para un cerebro externo (solo lectura).
 * GET /api/bot/context?identity=... | ?waIdentity=... | ?conversationId=...
 *
 * `identity` es el nombre neutro (hay contactos que no son de WhatsApp).
 * `waIdentity` se mantiene aceptado y presente en la respuesta porque es
 * contrato publicado: hay cerebros externos en produccion que dependen de el.
 * No tiene fecha de retiro.
 *
 * NO devuelve el historial de mensajes: el bot lleva su propia memoria de la
 * conversación. Lo que aquí sale es lo que solo el CRM sabe — quién es la
 * persona, si un humano tomó el control y si la ventana de 24 h sigue abierta.
 */
export async function GET(req: Request) {
  const auth = await authenticateBotRequest(req);
  if (!auth.ok) return auth.response;
  const organizationId = auth.organizationId;

  const url = new URL(req.url);
  const waIdentity =
    url.searchParams.get("identity") ?? url.searchParams.get("waIdentity");
  const conversationId = url.searchParams.get("conversationId");
  if (!waIdentity && !conversationId) {
    return apiError(422, "invalid", "Falta identity (o waIdentity) o conversationId");
  }

  const db = getDb();

  let contact: typeof schema.contact.$inferSelect | undefined;
  let conversation: typeof schema.conversation.$inferSelect | undefined;

  if (conversationId) {
    const rows = await db
      .select({ conversation: schema.conversation, contact: schema.contact })
      .from(schema.conversation)
      .innerJoin(
        schema.contact,
        and(
          eq(schema.conversation.contactId, schema.contact.id),
          eq(schema.contact.organizationId, schema.conversation.organizationId)
        )
      )
      .where(
        and(
          eq(schema.conversation.organizationId, organizationId),
          eq(schema.conversation.id, conversationId)
        )
      )
      .limit(1);
    contact = rows[0]?.contact;
    conversation = rows[0]?.conversation;
  } else if (waIdentity) {
    const contacts = await db
      .select()
      .from(schema.contact)
      .where(
        and(
          eq(schema.contact.organizationId, organizationId),
          eq(schema.contact.waIdentity, waIdentity)
        )
      )
      .limit(1);
    contact = contacts[0];
    if (contact) {
      // La conversación del Laboratorio jamás se resuelve por identidad: ese
      // camino es para el bot de producción, que nunca debe hablarle a un
      // cliente simulado.
      const convs = await db
        .select()
        .from(schema.conversation)
        .where(
          and(
            eq(schema.conversation.organizationId, organizationId),
            eq(schema.conversation.contactId, contact.id),
            eq(schema.conversation.isTest, false)
          )
        )
        .limit(1);
      conversation = convs[0];
    }
  }

  if (!contact || !conversation) {
    return apiError(404, "not_found", "Conversación no encontrada");
  }

  const leadRows = await db
    .select({ lead: schema.lead, stage: schema.pipelineStage })
    .from(schema.lead)
    .innerJoin(
      schema.pipelineStage,
      and(
        eq(schema.lead.stageId, schema.pipelineStage.id),
        eq(schema.pipelineStage.organizationId, schema.lead.organizationId)
      )
    )
    .where(
      and(
        eq(schema.lead.organizationId, organizationId),
        eq(schema.lead.contactId, contact.id)
      )
    )
    .limit(1);

  return Response.json({
    contact: {
      id: contact.id,
      name: contact.name,
      /** Nombre neutro (014). Preferir este en clientes nuevos. */
      identity: contact.waIdentity,
      /** Alias heredado: sigue aqui para no romper bots ya desplegados. */
      waIdentity: contact.waIdentity,
      channel: contact.channel,
      phone: contact.phone,
      ficha: serializeFicha(contact),
    },
    conversation: {
      id: conversation.id,
      // Una sola verdad para el bot: si hay handoff, la IA está apagada
      // aunque el flag siga en true.
      aiEnabled: conversation.aiEnabled && !conversation.handoffAt,
      handoffAt: conversation.handoffAt?.toISOString() ?? null,
      windowOpen: isWindowOpen(conversation.lastInboundAt),
      windowRemainingMs: windowRemainingMs(conversation.lastInboundAt),
    },
    lead: leadRows[0]
      ? { id: leadRows[0].lead.id, stageName: leadRows[0].stage.name }
      : null,
  });
}
