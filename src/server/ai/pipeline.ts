import { asc, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { moveLeadToStage as moveLeadThroughHistory } from "@/server/leads/stage-history";
import { getEnv, isAiConfigured } from "@/lib/env";
import { chatJson, type ChatMessage } from "@/lib/ai";
import { publish } from "@/server/events/bus";
import { isWindowOpen } from "@/server/inbox/window";
import { SendError, sendText } from "@/server/inbox/send";
import {
  agentActionSchema,
  degradeAction,
  resolveStage,
  type AgentActionType,
} from "@/server/ai/actions";
import { matchesHandoffIntent } from "@/server/ai/handoff";
import { buildAgentSystemPrompt } from "@/server/ai/prompts";
import { agendaEnabled } from "@/server/agenda/flag";
import {
  bookSlot,
  offerGeneralAvailability,
  offerNextAvailable,
  offerRange,
  offerSlots,
} from "@/server/agenda/agent";
import { BookingError, rescheduleForConversation } from "@/server/agenda/service";
import { getOffers, mapaDeHuecosParaModelo } from "@/server/agenda/offers";
import { getSettings } from "@/server/agenda/settings";
import { todayInTz, todayLabelInTz } from "@/lib/time/slots";
import {
  factualHoursReply,
  resolveScheduleIntent,
  type ScheduleIntent,
} from "@/server/agenda/schedule-intent";
import {
  resolveScheduleScope,
  type ScheduleScope,
} from "@/server/agenda/schedule-scope";
import { hasSchedulingSignal } from "@/server/agenda/schedule-request";

type CoalesceEntry = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  pending: boolean;
};

const globalForAgent = globalThis as unknown as {
  __agentCoalesce?: Map<string, CoalesceEntry>;
};

function coalesceMap(): Map<string, CoalesceEntry> {
  if (!globalForAgent.__agentCoalesce) {
    globalForAgent.__agentCoalesce = new Map();
  }
  return globalForAgent.__agentCoalesce;
}

/** Punto de entrada con debounce (mensajes entrantes reales). */
export function scheduleAgentTurn(conversationId: string): void {
  const map = coalesceMap();
  const entry = map.get(conversationId) ?? {
    timer: null,
    running: false,
    pending: false,
  };
  map.set(conversationId, entry);

  if (entry.running) {
    entry.pending = true;
    return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  const delay = getEnv().AGENT_COALESCE_MS;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void executeTurn(conversationId);
  }, delay);
}

async function executeTurn(conversationId: string): Promise<void> {
  const map = coalesceMap();
  const entry = map.get(conversationId);
  if (!entry || entry.running) return;
  entry.running = true;
  try {
    await runAgentTurn(conversationId);
  } catch (err) {
    console.error("[agente] turno falló:", err);
  } finally {
    entry.running = false;
    if (entry.pending) {
      entry.pending = false;
      void executeTurn(conversationId);
    } else {
      map.delete(conversationId);
    }
  }
}

export async function runAgentTurn(
  conversationId: string,
  expectedOrganizationId?: string
): Promise<void> {
  if (!isAiConfigured()) return;

  const db = getDb();
  const convRows = await db
    .select()
    .from(schema.conversation)
    .where(
      expectedOrganizationId
        ? scoped(
            schema.conversation.organizationId,
            expectedOrganizationId,
            eq(schema.conversation.id, conversationId)
          )
        : eq(schema.conversation.id, conversationId)
    )
    .limit(1);
  const conversation = convRows[0];
  if (!conversation) return;
  const organizationId = conversation.organizationId;

  if (conversation.handoffAt || !conversation.aiEnabled) return;

  const profileRows = await db
    .select()
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const profile = profileRows[0];
  if (!profile) return;
  if (!conversation.isTest && !profile.enabled) return;

  const history = await db
    .select()
    .from(schema.message)
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversationId)
      )
    )
    .orderBy(desc(schema.message.createdAt))
    .limit(20);
  history.reverse();
  const lastInbound = [...history].reverse().find((m) => m.direction === "in");
  if (!lastInbound) return;

  if (!conversation.isTest && !isWindowOpen(conversation.lastInboundAt)) {
    await applyHandoff(conversationId, organizationId, "ventana");
    return;
  }

  if (lastInbound.text && matchesHandoffIntent(lastInbound.text)) {
    await applyHandoff(conversationId, organizationId, "cliente");
    return;
  }

  const kb = await db
    .select()
    .from(schema.kbEntry)
    .where(eq(schema.kbEntry.organizationId, organizationId))
    .orderBy(asc(schema.kbEntry.createdAt));
  const stages = await db
    .select({ id: schema.pipelineStage.id, name: schema.pipelineStage.name })
    .from(schema.pipelineStage)
    .where(eq(schema.pipelineStage.organizationId, organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  const agenda = agendaEnabled();
  const ofertas = agenda ? await getOffers(organizationId, conversationId) : [];
  const mapaDeHuecos = mapaDeHuecosParaModelo(ofertas);

  let todayInfo: { iso: string; label: string } | undefined;
  let scheduleIntent: ScheduleIntent = { kind: "none" };
  let scheduleScope: ScheduleScope | null = null;
  let schedulingSignal = false;
  let businessFact: Parameters<typeof buildAgentSystemPrompt>[0]["businessFact"];
  if (agenda) {
    const settings = await getSettings(organizationId);
    const now = new Date();
    todayInfo = {
      iso: todayInTz(now, settings.timezone),
      label: todayLabelInTz(now, settings.timezone),
    };
    schedulingSignal = lastInbound.text
      ? hasSchedulingSignal({ text: lastInbound.text, now, timezone: settings.timezone })
      : false;
    scheduleScope = lastInbound.text
      ? resolveScheduleScope(lastInbound.text, now, settings.timezone)
      : null;
    scheduleIntent = lastInbound.text
      ? resolveScheduleIntent({
          text: lastInbound.text,
          now,
          weeklyHours: settings.weeklyHours,
          timezone: settings.timezone,
        })
      : { kind: "none" };
    if (scheduleIntent.kind === "date_mentioned") {
      businessFact = {
        targetDate: scheduleIntent.targetDate,
        dayOfWeekLabel: scheduleIntent.dateLabel,
        businessOpen: scheduleIntent.businessOpen,
        businessHours: scheduleIntent.businessHours,
        timezone: scheduleIntent.timezone,
      };
    }
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildAgentSystemPrompt({
        profile,
        kb,
        stages,
        agenda,
        today: todayInfo,
        businessFact,
      }),
    },
    ...history
      .filter((m) => m.text)
      .map((m) => ({
        role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
        content: m.text!,
      })),
    ...(mapaDeHuecos
      ? [{ role: "system" as const, content: mapaDeHuecos }]
      : []),
  ];

  const result = await chatJson(agentActionSchema(agenda), messages);
  if (!result.ok) {
    if (result.error === "not_configured") return;
    console.error(`[agente] fallo del proveedor (raw): ${result.detail}`);
    await applyHandoff(conversationId, organizationId, "error");
    return;
  }

  let action: AgentActionType = result.data;

  // El modelo no puede abrir la agenda por una pregunta informativa. El gate
  // usa el inbound real ya cargado por el pipeline, sin hacer una segunda
  // consulta a BD y sin afectar las re-ofertas internas de book/reschedule.
  if (agenda && action.action === "offer_slots" && !schedulingSignal) {
    action = degradeAction(action);
  }

  if (
    agenda &&
    scheduleScope &&
    scheduleScope.type !== "single_date" &&
    (action.action === "reply" || action.action === "offer_slots")
  ) {
    try {
      const turn =
        scheduleScope.type === "date_range"
          ? await offerRange({
              organizationId,
              conversationId,
              startDate: scheduleScope.startDate,
              endDate: scheduleScope.endDate,
            })
          : scheduleScope.type === "general_availability"
            ? await offerGeneralAvailability({ organizationId, conversationId })
            : await offerNextAvailable({ organizationId, conversationId });
      await deliverReply(conversation, turn.text);
      if (turn.ok) {
        publish(organizationId, {
          type: "conversation.updated",
          data: { conversation: { id: conversationId } },
        });
      }
      return;
    } catch (err) {
      console.error(`[agente] el motor de agenda (rango/general) falló: ${err}`);
      action = degradeAction(action);
    }
  }

  if (
    agenda &&
    scheduleIntent.kind === "date_mentioned" &&
    (action.action === "reply" || action.action === "offer_slots")
  ) {
    if (!scheduleIntent.requiresAvailabilityLookup) {
      await deliverReply(conversation, factualHoursReply(scheduleIntent));
      return;
    }
    action = { action: "offer_slots", day: scheduleIntent.targetDate };
  }

  if (
    action.action === "offer_slots" ||
    action.action === "book_slot" ||
    action.action === "reschedule_slot"
  ) {
    if (!agenda) {
      action = degradeAction(action);
    } else {
      try {
        let turn;
        if (action.action === "offer_slots") {
          turn = await offerSlots({
            organizationId,
            conversationId,
            intro: action.reply,
            day:
              scheduleIntent.kind === "date_mentioned"
                ? scheduleIntent.targetDate
                : action.day,
            businessFact:
              scheduleIntent.kind === "date_mentioned"
                ? {
                    businessOpen: scheduleIntent.businessOpen,
                    businessHours: scheduleIntent.businessHours,
                    dateLabel: scheduleIntent.dateLabel,
                  }
                : undefined,
          });
        } else if (action.action === "book_slot") {
          turn = await bookSlot({
            organizationId,
            conversationId,
            startUtc: action.startUtc,
          });
        } else {
          try {
            const moved = await rescheduleForConversation({
              organizationId,
              conversationId,
              startUtc: action.startUtc,
            });
            turn = {
              ok: true,
              text: moved.meetingLink
                ? `¡Listo! Reprogramé tu cita para ${moved.label}.\nEnlace: ${moved.meetingLink}`
                : `¡Listo! Reprogramé tu cita para ${moved.label}.`,
            };
          } catch (err) {
            if (err instanceof BookingError && err.code === "slot_not_offered") {
              turn = await offerSlots({
                organizationId,
                conversationId,
                intro: "Para cambiar tu cita, elige uno de estos horarios disponibles:",
                day:
                  scheduleIntent.kind === "date_mentioned"
                    ? scheduleIntent.targetDate
                    : undefined,
                businessFact:
                  scheduleIntent.kind === "date_mentioned"
                    ? {
                        businessOpen: scheduleIntent.businessOpen,
                        businessHours: scheduleIntent.businessHours,
                        dateLabel: scheduleIntent.dateLabel,
                      }
                    : undefined,
              });
            } else if (err instanceof BookingError && err.code === "not_found") {
              turn = {
                ok: false,
                text: "No encontré una cita activa para reprogramar. Si quieres, puedo mostrarte horarios disponibles para una nueva cita.",
              };
            } else if (err instanceof BookingError && err.code === "slot_taken") {
              turn = await offerSlots({
                organizationId,
                conversationId,
                intro: "Ese horario ya no está disponible. Estas son las opciones actuales:",
              });
            } else {
              throw err;
            }
          }
        }

        await deliverReply(conversation, turn.text);
        if (turn.ok) {
          publish(organizationId, {
            type: "conversation.updated",
            data: { conversation: { id: conversationId } },
          });
        }
        return;
      } catch (err) {
        console.error(`[agente] el motor de agenda falló: ${err}`);
        action = degradeAction(action);
      }
    }
  }

  if (action.action === "move_stage") {
    const stage = resolveStage(action.stage, stages);
    if (!stage) {
      action = degradeAction(action);
    } else {
      const moveResult = await moveLeadToStage(
        organizationId,
        conversation.contactId,
        stage.id
      );
      if (moveResult === "lead_missing" || moveResult === "rejected") {
        await deliverReply(
          conversation,
          "Voy a pasar tu solicitud a un asesor para continuar."
        );
        await applyHandoff(conversationId, organizationId, "error");
        return;
      }
      if (moveResult === "moved") {
        publish(organizationId, {
          type: "conversation.updated",
          data: { conversation: { id: conversationId } },
        });
      }
      if (action.reply) {
        await deliverReply(conversation, action.reply);
      }
      return;
    }
  }

  switch (action.action) {
    case "none":
      return;
    case "reply":
      await deliverReply(conversation, action.text);
      return;
    case "update_lead": {
      const updated = await appendLeadNote(
        organizationId,
        conversation.contactId,
        action.note
      );
      if (!updated) {
        await deliverReply(
          conversation,
          "Voy a pasar tu solicitud a un asesor para continuar."
        );
        await applyHandoff(conversationId, organizationId, "error");
        return;
      }
      if (action.reply) await deliverReply(conversation, action.reply);
      return;
    }
    case "handoff": {
      if (action.farewell) {
        await deliverReply(conversation, action.farewell);
      }
      await applyHandoff(conversationId, organizationId, "modelo");
      return;
    }
    case "offer_slots":
    case "book_slot":
    case "reschedule_slot":
      return;
  }
}

type Conversation = typeof schema.conversation.$inferSelect;

async function deliverReply(
  conversation: Conversation,
  text: string
): Promise<void> {
  if (conversation.isTest) {
    await persistTestOutbound(conversation, text);
    return;
  }
  try {
    await sendText({
      conversationId: conversation.id,
      organizationId: conversation.organizationId,
      text,
      aiGenerated: true,
    });
  } catch (err) {
    if (err instanceof SendError && err.code === "window_closed") {
      await applyHandoff(
        conversation.id,
        conversation.organizationId,
        "ventana"
      );
      return;
    }
    throw err;
  }
}

async function persistTestOutbound(
  conversation: Conversation,
  text: string
): Promise<void> {
  const db = getDb();
  await db.insert(schema.message).values({
    id: newId("message"),
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    direction: "out",
    type: "text",
    text,
    status: "sent",
    aiGenerated: true,
    origin: "ai",
  });
  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(
      scoped(
        schema.conversation.organizationId,
        conversation.organizationId,
        eq(schema.conversation.id, conversation.id)
      )
    );
}

export async function applyHandoff(
  conversationId: string,
  organizationId: string,
  reason: "cliente" | "modelo" | "error" | "ventana"
): Promise<void> {
  const db = getDb();
  const updated = await db
    .update(schema.conversation)
    .set({ handoffAt: new Date(), handoffReason: reason, updatedAt: new Date() })
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId)
      )
    )
    .returning();
  if (!updated[0]) return;
  publish(organizationId, {
    type: "conversation.updated",
    data: {
      conversation: { id: conversationId, handoffReason: reason },
    },
  });
}

type AgentStageMoveResult =
  | "moved"
  | "already"
  | "lead_missing"
  | "rejected";

async function moveLeadToStage(
  organizationId: string,
  contactId: string,
  stageId: string
): Promise<AgentStageMoveResult> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.lead.contactId, contactId)
      )
    )
    .limit(1);
  const leadId = rows[0]?.id;
  if (!leadId) return "lead_missing";

  const result = await moveLeadThroughHistory({
    organizationId,
    leadId,
    toStageId: stageId,
    source: "bot",
    extra: { lastActivityAt: new Date() },
  });
  if (!result.ok) return "rejected";
  return result.changed ? "moved" : "already";
}

async function appendLeadNote(
  organizationId: string,
  contactId: string,
  note: string
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.contact.id, notes: schema.contact.notes })
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        organizationId,
        eq(schema.contact.id, contactId)
      )
    )
    .limit(1);
  const contact = rows[0];
  if (!contact) return false;
  const stamped = `[IA] ${note}`;
  await db
    .update(schema.contact)
    .set({
      notes: contact.notes ? `${contact.notes}\n${stamped}` : stamped,
      updatedAt: new Date(),
    })
    .where(
      scoped(
        schema.contact.organizationId,
        organizationId,
        eq(schema.contact.id, contact.id)
      )
    );
  return true;
}
