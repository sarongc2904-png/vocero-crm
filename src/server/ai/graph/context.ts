import { asc, desc, eq } from "drizzle-orm";
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
  now: Date;
};

export type LoadedShadowContext = {
  context: ShadowContext | null;
  commercialAccess: boolean;
  agendaEnabled: boolean;
  whatsappWindowOpen: boolean;
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
  const commercialAccess =
    conversation.isTest ||
    (await hasCommercialAccess(organizationId, input.now));

  // Replica el orden del pipeline productivo: un tenant sin entitlement no
  // causa lecturas adicionales de perfil, historial, KB ni agenda.
  if (!commercialAccess) {
    return {
      context: {
        now: input.now,
        conversation,
        profile: null,
        history: [],
        lastInboundText: null,
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
          eq(schema.message.conversationId, conversation.id)
        )
      )
      .orderBy(desc(schema.message.createdAt))
      .limit(20),
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

  historyRows.reverse();
  const lastInbound = [...historyRows]
    .reverse()
    .find((message) => message.direction === "in");
  const lastOutbound = [...historyRows]
    .reverse()
    .find(
      (message) =>
        message.direction === "out" &&
        (!lastInbound || message.createdAt < lastInbound.createdAt)
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
      lastInboundText: lastInbound?.text ?? null,
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
