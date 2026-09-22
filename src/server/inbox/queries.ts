import { and, desc, eq, gt, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { isWindowOpen, windowRemainingMs } from "@/server/inbox/window";
import type { ConversationDto } from "@/lib/types";

export async function listConversations(
  organizationId: string,
  since?: Date
): Promise<ConversationDto[]> {
  const db = getDb();
  const previewSql = sql<string | null>`(
    select coalesce(m.text, m.type)
    from message m
    where m.conversation_id = ${schema.conversation.id}
      and m.organization_id = ${schema.conversation.organizationId}
    order by m.created_at desc
    limit 1
  )`;
  const stageSql = sql<string | null>`(
    select s.name from lead l
    join pipeline_stage s on s.id = l.stage_id
    where l.contact_id = ${schema.contact.id}
      and l.organization_id = ${schema.contact.organizationId}
      and s.organization_id = l.organization_id
    limit 1
  )`;
  const nextActionTypeSql = sql<string | null>`(
    select l.next_action_type
    from lead l
    where l.contact_id = ${schema.contact.id}
      and l.organization_id = ${schema.contact.organizationId}
    limit 1
  )`;
  const nextActionAtSql = sql<Date | null>`(
    select l.next_action_at
    from lead l
    where l.contact_id = ${schema.contact.id}
      and l.organization_id = ${schema.contact.organizationId}
    limit 1
  )`;
  const needsReply30mSql = sql<boolean>`(
    ${schema.conversation.lastInboundAt} is not null
    and ${schema.conversation.lastInboundAt} <= now() - interval '30 minutes'
    and not exists (
      select 1
      from message m
      where m.organization_id = ${schema.conversation.organizationId}
        and m.conversation_id = ${schema.conversation.id}
        and m.direction = 'out'
        and coalesce(m.wa_timestamp, m.created_at) > ${schema.conversation.lastInboundAt}
    )
  )`;

  const rows = await db
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
      preview: previewSql,
      stageName: stageSql,
      nextActionType: nextActionTypeSql,
      nextActionAt: nextActionAtSql,
      needsReply30m: needsReply30mSql,
    })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      and(
        eq(schema.conversation.contactId, schema.contact.id),
        eq(schema.contact.organizationId, schema.conversation.organizationId)
      )
    )
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.isTest, false),
        since ? gt(schema.conversation.updatedAt, since) : undefined
      )
    )
    .orderBy(desc(sql`coalesce(${schema.conversation.lastMessageAt}, ${schema.conversation.createdAt})`));

  return rows.map((r) =>
    serializeConversation(
      r.conversation,
      r.contact,
      r.preview,
      r.stageName,
      r.nextActionType,
      r.nextActionAt,
      r.needsReply30m
    )
  );
}

export async function getConversation(
  organizationId: string,
  conversationId: string
) {
  const db = getDb();
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
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listMessages(
  organizationId: string,
  conversationId: string,
  since?: Date
) {
  const db = getDb();
  return db
    .select({ message: schema.message, media: schema.mediaAsset })
    .from(schema.message)
    .leftJoin(
      schema.mediaAsset,
      and(
        eq(schema.message.mediaAssetId, schema.mediaAsset.id),
        eq(schema.mediaAsset.organizationId, schema.message.organizationId)
      )
    )
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversationId),
        since ? gt(schema.message.createdAt, since) : undefined
      )
    )
    .orderBy(schema.message.createdAt);
}

export function serializeConversation(
  c: typeof schema.conversation.$inferSelect,
  contact: typeof schema.contact.$inferSelect,
  preview: string | null = null,
  stageName: string | null = null,
  nextActionType: string | null = null,
  nextActionAt: Date | null = null,
  needsReply30m = false
): ConversationDto {
  return {
    id: c.id,
    channel: c.channel,
    contact: { id: contact.id, name: contact.name, phone: contact.phone },
    stageName,
    aiEnabled: c.aiEnabled,
    handoffAt: c.handoffAt?.toISOString() ?? null,
    handoffReason: c.handoffReason,
    needsReply30m,
    nextActionType: (
      nextActionType === "llamar" ||
      nextActionType === "whatsapp" ||
      nextActionType === "cotizacion" ||
      nextActionType === "seguimiento" ||
      nextActionType === "cita" ||
      nextActionType === "otro"
        ? nextActionType
        : null
    ),
    nextActionAt: nextActionAt?.toISOString() ?? null,
    nextActionOverdue: Boolean(nextActionAt && nextActionAt.getTime() < Date.now()),
    lastInboundAt: c.lastInboundAt?.toISOString() ?? null,
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    unreadCount: c.unreadCount,
    windowOpen: isWindowOpen(c.lastInboundAt),
    windowRemainingMs: windowRemainingMs(c.lastInboundAt),
    preview,
  };
}

export async function updateConversation(
  organizationId: string,
  conversationId: string,
  patch: { aiEnabled?: boolean; reactivate?: boolean; markRead?: boolean }
) {
  const db = getDb();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.aiEnabled !== undefined) set.aiEnabled = patch.aiEnabled;
  if (patch.reactivate) {
    set.handoffAt = null;
    set.handoffReason = null;
    set.aiEnabled = patch.aiEnabled ?? true;
  }
  if (patch.markRead) set.unreadCount = 0;

  const updated = await db
    .update(schema.conversation)
    .set(set)
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.id, conversationId)
      )
    )
    .returning();
  return updated[0] ?? null;
}
