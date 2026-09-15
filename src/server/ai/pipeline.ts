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
import { bookSlot, offerSlots } from "@/server/agenda/agent";
import { getOffers, mapaDeHuecosParaModelo } from "@/server/agenda/offers";
import { getSettings } from "@/server/agenda/settings";
import { todayInTz, todayLabelInTz } from "@/lib/time/slots";
import {
  factualHoursReply,
  resolveScheduleIntent,
  type ScheduleIntent,
} from "@/server/agenda/schedule-intent";

/**
 * Turno del agente (FR-021..FR-025).
 *
 * Coalesce + lock in-process por conversación: ráfagas de mensajes → UNA
 * respuesta; nunca dos turnos simultáneos; lo que llega durante un turno
 * re-encola exactamente un turno más. Suficiente para el monolito de una
 * instancia (sin colas externas — Constitución II).
 */

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
    entry.pending = true; // se re-encola al terminar el turno actual
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

/**
 * Ejecuta UN turno del agente ahora (el Laboratorio lo llama directo, con
 * debounce 0 y sin pasar por el coalesce).
 */
export async function runAgentTurn(conversationId: string): Promise<void> {
  if (!isAiConfigured()) return;

  const db = getDb();
  const convRows = await db
    .select()
    .from(schema.conversation)
    .where(eq(schema.conversation.id, conversationId))
    .limit(1);
  const conversation = convRows[0];
  if (!conversation) return;
  const organizationId = conversation.organizationId;

  // Condiciones de silencio: handoff activo o IA apagada en la conversación.
  if (conversation.handoffAt || !conversation.aiEnabled) return;

  const profileRows = await db
    .select()
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const profile = profileRows[0];
  if (!profile) return;
  // El toggle global aplica a conversaciones reales; el Laboratorio evalúa el
  // comportamiento configurado aunque el agente aún no esté encendido.
  if (!conversation.isTest && !profile.enabled) return;

  const history = await db
    .select()
    .from(schema.message)
    .where(eq(schema.message.conversationId, conversationId))
    .orderBy(desc(schema.message.createdAt))
    .limit(20);
  history.reverse();
  const lastInbound = [...history].reverse().find((m) => m.direction === "in");
  if (!lastInbound) return;

  // Ventana cerrada: el agente JAMÁS envía texto libre → handoff 'ventana'.
  if (!conversation.isTest && !isWindowOpen(conversation.lastInboundAt)) {
    await applyHandoff(conversationId, organizationId, "ventana");
    return;
  }

  // Patrón de respaldo ANTES del LLM (FR-022).
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

  /**
   * 015 — Los huecos vigentes, con su instante exacto.
   *
   * `book_slot` exige el `startUtc` y `findOffered` compara por epoch, sin
   * tolerancia. Pero al modelo solo le llegaban el prompt y el historial de
   * TEXTO, donde están las etiquetas que leyó el cliente —«lun 7 sep, 11:00»—
   * sin año, sin zona y sin la fecha de hoy. Con eso, acertar el instante era
   * cuestión de suerte: el rechazo caía siempre en `slot_not_offered`, cuyo
   * texto es fijo, y la conversación se quedaba en bucle repitiendo la lista.
   *
   * Es un agujero de INTEGRACIÓN: las pruebas de contrato pasan porque
   * inyectan el ISO correcto, que es justo lo que el modelo no tenía.
   *
   * Sin oferta vigente no se añade nada, así que el modelo sigue obligado a
   * ofrecer antes de reservar. Se entrega el catálogo COMPLETO, no solo los
   * tres que se enseñaron: si el cliente pide otro día, ese hueco ya estaba
   * registrado como ofrecido y ahora el modelo también lo conoce.
   *
   * Reportado por @Diony7004 en #50, con el diagnóstico ya hecho.
   */
  const ofertas = agenda ? await getOffers(organizationId, conversationId) : [];
  const mapaDeHuecos = mapaDeHuecosParaModelo(ofertas);

  /**
   * Ancla de fecha para `offer_slots.day` (ver prompts.ts / #agenda-fecha):
   * sin decirle al modelo qué día es hoy, no tiene forma de calcular "mañana"
   * o "el viernes" — solo cuando hay agenda, para no pagar la consulta si la
   * instancia no la usa.
   */
  let todayInfo: { iso: string; label: string } | undefined;
  /**
   * Fase 1 — verdad de agenda resuelta por el BACKEND (`resolveScheduleIntent`),
   * nunca por el modelo. Causa raíz del bug de agenda (día equivocado) y de
   * la regresión de domingo (el agente decía "cerrado" con el domingo
   * configurado abierto): antes esta verdad solo viajaba como INSTRUCCIÓN del
   * prompt — un texto libre del modelo (`{"action":"reply",...}`) podía
   * seguir contradiciéndola sin que nada lo impidiera. Ahora, si el último
   * mensaje del cliente menciona una fecha, el pipeline usa este resultado
   * para CONSTRUIR o REEMPLAZAR la respuesta cuando la acción del modelo es
   * `reply` u `offer_slots` (ver más abajo) — no es una instrucción que el
   * modelo pueda desobedecer.
   */
  let scheduleIntent: ScheduleIntent = { kind: "none" };
  let businessFact: Parameters<typeof buildAgentSystemPrompt>[0]["businessFact"];
  if (agenda) {
    const settings = await getSettings(organizationId);
    const now = new Date();
    todayInfo = {
      iso: todayInTz(now, settings.timezone),
      label: todayLabelInTz(now, settings.timezone),
    };
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
    /**
     * Va AL FINAL, después del historial: es el estado de AHORA, y ponerlo
     * antes lo dejaría enterrado bajo la conversación en cuanto esta crezca.
     */
    ...(mapaDeHuecos
      ? [{ role: "system" as const, content: mapaDeHuecos }]
      : []),
  ];

  const result = await chatJson(agentActionSchema(agenda), messages);
  if (!result.ok) {
    if (result.error === "not_configured") return;
    // Fallo persistente del proveedor o salida imposible → escalar (FR-022).
    console.error(`[agente] fallo del proveedor (raw): ${result.detail}`);
    await applyHandoff(conversationId, organizationId, "error");
    return;
  }

  let action: AgentActionType = result.data;

  /**
   * Fase 1 (fix domingo) — el guardarraíl que faltaba. Si el backend
   * reconoció una fecha en el mensaje del cliente, la verdad de agenda para
   * esa fecha la decide el backend — nunca el texto libre del modelo. Se
   * activa SOLO sobre `reply` (el camino sin ningún control hasta ahora) y
   * `offer_slots` (para que su `day` e `intro` también queden bajo el mismo
   * control): las demás acciones (`handoff`, `move_stage`, `update_lead`,
   * `book_slot`, `none`) expresan una intención distinta del modelo que este
   * guardarraíl no debe pisar.
   *
   * Se descarta el `reply`/`intro` que haya escrito el modelo por completo —
   * no se usa ni como introducción — porque un modelo adversarial (o
   * simplemente equivocado) podría escribir "el domingo estamos cerrados"
   * como intro de un `offer_slots` que igual muestra los horarios reales del
   * domingo: el resultado sería un mensaje contradictorio. Todo lo que se
   * envía en este camino sale de `scheduleIntent`/`offerSlots`, nunca del
   * modelo.
   */
  if (
    agenda &&
    scheduleIntent.kind === "date_mentioned" &&
    (action.action === "reply" || action.action === "offer_slots")
  ) {
    if (!scheduleIntent.requiresAvailabilityLookup) {
      // Caso 2: solo preguntó si se trabaja ese día / el horario — sin pedir
      // ver huecos todavía. Respuesta corta, 100% del backend.
      await deliverReply(conversation, factualHoursReply(scheduleIntent));
      return;
    }
    action = { action: "offer_slots", day: scheduleIntent.targetDate };
  }

  // 015 — Agenda. Un fallo del motor degrada el turno (el agente responde sin
  // agendar), nunca lo tumba: quedarse callado es peor que no agendar.
  if (action.action === "offer_slots" || action.action === "book_slot") {
    if (!agenda) {
      action = degradeAction(action);
    } else {
      try {
        const turn =
          action.action === "offer_slots"
            ? await offerSlots({
                organizationId,
                conversationId,
                intro: action.reply,
                // El backend manda: si `resolveScheduleIntent` reconoció una
                // fecha en el mensaje del cliente, el `day` del modelo NO
                // puede sobrescribirla — es solo respaldo cuando el parser
                // no reconoció nada.
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
              })
            : await bookSlot({
                organizationId,
                conversationId,
                startUtc: action.startUtc,
              });
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
      await moveLeadToStage(organizationId, conversation.contactId, stage.id);
      publish(organizationId, {
        type: "conversation.updated",
        data: { conversation: { id: conversationId } },
      });
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
      await appendLeadNote(organizationId, conversation.contactId, action.note);
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
  }
}

type Conversation = typeof schema.conversation.$inferSelect;

/** Entrega la respuesta: envío real o persistencia sandbox (is_test). */
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
      await applyHandoff(conversation.id, conversation.organizationId, "ventana");
      return;
    }
    throw err;
  }
}

/** Mensaje saliente del sandbox: se persiste, JAMÁS toca la API (FR-031). */
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
    .where(eq(schema.conversation.id, conversation.id));
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
    .where(eq(schema.conversation.id, conversationId))
    .returning();
  if (!updated[0]) return;
  publish(organizationId, {
    type: "conversation.updated",
    data: {
      conversation: { id: conversationId, handoffReason: reason },
    },
  });
}

async function moveLeadToStage(
  organizationId: string,
  contactId: string,
  stageId: string
): Promise<void> {
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
  if (!leadId) return;

  // Por la puerta única: el agente mueve tarjetas igual que el dueño, y su
  // movimiento tiene que quedar en la bitácora o el embudo mentirá sobre
  // quién hizo avanzar cada lead.
  await moveLeadThroughHistory({
    organizationId,
    leadId,
    toStageId: stageId,
    source: "bot",
    extra: { lastActivityAt: new Date() },
    // El agente no clasifica pérdidas: si su etapa destino resultara ser la
    // perdida, la puerta lo rechaza y el lead se queda donde está — mejor eso
    // que un motivo inventado.
  });
}

async function appendLeadNote(
  organizationId: string,
  contactId: string,
  note: string
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.contact.id, notes: schema.contact.notes })
    .from(schema.contact)
    .where(eq(schema.contact.id, contactId))
    .limit(1);
  const contact = rows[0];
  if (!contact) return;
  const stamped = `[IA] ${note}`;
  await db
    .update(schema.contact)
    .set({
      notes: contact.notes ? `${contact.notes}\n${stamped}` : stamped,
      updatedAt: new Date(),
    })
    .where(eq(schema.contact.id, contact.id));
}
