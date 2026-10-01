import { asc, desc, eq, gte, lt, ne } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { currentOffers, getOffers } from "@/server/agenda/offers";
import { peekPendingAction } from "@/server/agenda/pending-actions";
import { agendaEnabled } from "@/server/agenda/flag";
import { getSettings } from "@/server/agenda/settings";
import { hasCommercialAccess } from "@/server/commercial/entitlement";
import { isWindowOpen } from "@/server/inbox/window";
import type { ShadowContext } from "@/server/ai/graph/state";

export type ShadowContextInput = {
  conversationId: string;
  expectedOrganizationId: string;
  expectedInboundMessageId: string;
  now: Date;
};

export type LoadedShadowContext = {
  context: ShadowContext | null;
  commercialAccess: boolean;
  agendaEnabled: boolean;
  whatsappWindowOpen: boolean;
  failureReason?: "inbound_not_found" | "inbound_mismatch";
};

/**
 * Snapshot de solo lectura. La primera consulta siempre exige conversación y
 * tenant: no existe una variante pública que consulte solo por id.
 */
export async function loadShadowContext(
  input: ShadowContextInput
): Promise<LoadedShadowContext> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        input.expectedOrganizationId,
        eq(schema.conversation.id, input.conversationId)
      )
    )
    .limit(1);
  const conversation = rows[0];
  const agenda = agendaEnabled();
  if (!conversation) {
    return {
      context: null,
      commercialAccess: false,
      agendaEnabled: agenda,
      whatsappWindowOpen: false,
    };
  }

  const organizationId = conversation.organizationId;
  const expectedInboundRows = await db
    .select()
    .from(schema.message)
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversation.id),
        eq(schema.message.id, input.expectedInboundMessageId),
        eq(schema.message.direction, "in")
      )
    )
    .limit(1);
  const expectedInbound = expectedInboundRows[0];
  if (!expectedInbound) {
    return {
      context: null,
      commercialAccess: false,
      agendaEnabled: agenda,
      whatsappWindowOpen: false,
      failureReason: "inbound_not_found",
    };
  }

  const [commercialAccess, competingInboundRows] = await Promise.all([
    conversation.isTest
      ? Promise.resolve(true)
      : hasCommercialAccess(organizationId, input.now),
    db
      .select()
      .from(schema.message)
      .where(
        scoped(
          schema.message.organizationId,
          organizationId,
          eq(schema.message.conversationId, conversation.id),
          eq(schema.message.direction, "in"),
          gte(schema.message.createdAt, expectedInbound.createdAt),
          ne(schema.message.id, expectedInbound.id)
        )
      )
      .orderBy(desc(schema.message.createdAt))
      .limit(1),
  ]);
  if (competingInboundRows.length > 0) {
    return {
      context: null,
      commercialAccess,
      agendaEnabled: agenda,
      whatsappWindowOpen: false,
      failureReason: "inbound_mismatch",
    };
  }

  // Replica el orden del pipeline productivo: salvo el inbound mínimo usado
  // para correlacionar el evento, un tenant sin entitlement no causa lecturas
  // adicionales de perfil, historial, KB ni agenda.
  if (!commercialAccess) {
    return {
      context: {
        now: input.now,
        conversation,
        profile: null,
        history: [],
        lastInboundMessageId: expectedInbound.id,
        lastInboundText: expectedInbound.text ?? null,
        lastOutboundText: null,
        lastOutboundAt: null,
        kb: [],
        stages: [],
        settings: null,
        offers: [],
        pendingAction: null,
      },
      commercialAccess: false,
      agendaEnabled: agenda,
      whatsappWindowOpen: false,
    };
  }

  const [profiles, historyRows, kb, stages] = await Promise.all([
    db
      .select()
      .from(schema.agentProfile)
      .where(eq(schema.agentProfile.organizationId, organizationId))
      .limit(1),
    db
      .select()
      .from(schema.message)
      .where(
        scoped(
          schema.message.organizationId,
          organizationId,
          eq(schema.message.conversationId, conversation.id),
          lt(schema.message.createdAt, expectedInbound.createdAt)
        )
      )
      .orderBy(desc(schema.message.createdAt))
      .limit(19),
    db
      .select()
      .from(schema.kbEntry)
      .where(eq(schema.kbEntry.organizationId, organizationId))
      .orderBy(asc(schema.kbEntry.createdAt)),
    db
      .select({ id: schema.pipelineStage.id, name: schema.pipelineStage.name })
      .from(schema.pipelineStage)
      .where(eq(schema.pipelineStage.organizationId, organizationId))
      .orderBy(asc(schema.pipelineStage.position)),
  ]);

  historyRows.unshift(expectedInbound);
  historyRows.reverse();
  const lastOutbound = [...historyRows]
    .reverse()
    .find(
      (message) =>
        message.direction === "out" &&
        message.createdAt < expectedInbound.createdAt
    );

  const settings = agenda ? await getSettings(organizationId) : null;
  const [offers, pendingAction] = agenda && settings
    ? await Promise.all([
        getOffers(organizationId, conversation.id).then((stored) =>
          currentOffers(stored, {
            now: input.now,
            minNoticeHours: settings.minNoticeHours,
            timezone: settings.timezone,
          })
        ),
        peekPendingAction(organizationId, conversation.id, input.now),
      ])
    : [[], null];

  return {
    context: {
      now: input.now,
      conversation,
      profile: profiles[0] ?? null,
      history: historyRows
        .filter((message) => Boolean(message.text))
        .map((message) => ({
          role: message.direction === "in" ? "user" : "assistant",
          content: message.text!,
        })),
      lastInboundMessageId: expectedInbound.id,
      lastInboundText: expectedInbound.text ?? null,
      lastOutboundText: lastOutbound?.text ?? null,
      lastOutboundAt: lastOutbound?.createdAt ?? null,
      kb,
      stages,
      settings,
      offers,
      pendingAction,
    },
    commercialAccess,
    agendaEnabled: agenda,
    whatsappWindowOpen:
      conversation.isTest || isWindowOpen(conversation.lastInboundAt, input.now),
  };
}
