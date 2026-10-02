import { asc, desc, eq, gte, isNull } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { moveLeadToStage as moveLeadThroughHistory } from "@/server/leads/stage-history";
import { isAiConfigured } from "@/lib/env";
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
import {
  matchesHandoffIntent,
  shouldAllowModelHandoff,
} from "@/server/ai/handoff";
import { matchesCancellationIntent } from "@/server/agenda/cancel-intent";
import {
  buildAgentSystemPrompt,
  buildDocumentKnowledgeMessages,
} from "@/server/ai/prompts";
import { retrieveRelevantDocumentChunks } from "@/server/kb/documents/retrieval";
import { agendaEnabled } from "@/server/agenda/flag";
import {
  bookSlot,
  offerGeneralAvailability,
  offerNextAvailable,
  offerRange,
  offerSlots,
} from "@/server/agenda/agent";
import {
  BookingError,
  cancelBookingForConversation,
  rescheduleForConversation,
} from "@/server/agenda/service";
import {
  currentOffers,
  findOffered,
  getOffers,
  mapaDeHuecosParaModelo,
} from "@/server/agenda/offers";
import { resolveExpandRequest, type ExpandWindow } from "@/server/agenda/expand";
import {
  hasBookingConfirmation,
  isAffirmativeConfirmation,
  isBareTimeSelection,
  resolveOfferedTimeSelection,
  selectedOfferConfirmationLabel,
} from "@/server/agenda/selection";
import {
  clearPendingAction,
  getPendingAction,
  setPendingAction,
} from "@/server/agenda/pending-actions";
import {
  advanceOfferCursor,
  resetOfferCursor,
} from "@/server/agenda/offer-cursor";
import { getSettings } from "@/server/agenda/settings";
import { findSlot } from "@/server/agenda/availability";
import { findProfessionalSlot } from "@/server/agenda/professional-availability";
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
import { hasCommercialAccess } from "@/server/commercial/entitlement";
import { enforceAgentCapabilities } from "@/server/ai/capability-guard";

/**
 * Compatibilidad para callers existentes: el scheduling ahora se persiste en
 * Postgres. El import dinámico evita un ciclo estático con el worker que, a su
 * vez, ejecuta runAgentTurn.
 */
export async function scheduleAgentTurn(
  organizationId: string,
  conversationId: string
): Promise<void> {
  const { enqueueAgentTurn } = await import("@/server/jobs/queue");
  await enqueueAgentTurn(organizationId, conversationId);
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

  // Defensa para jobs ya encolados cuando el trial expira entre la ingesta y
  // la ejecución. El mensaje queda persistido, pero la IA no consume ni envía.
  if (!conversation.isTest && !(await hasCommercialAccess(organizationId))) return;

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
      conversation.aiContextResetAt
        ? scoped(
            schema.message.organizationId,
            organizationId,
            eq(schema.message.conversationId, conversationId),
            gte(schema.message.createdAt, conversation.aiContextResetAt)
          )
        : scoped(
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

  const repeatedGreeting = Boolean(
    lastInbound.text &&
      isBareGreeting(lastInbound.text) &&
      history.some(
        (m) =>
          m.direction === "out" &&
          m.createdAt < lastInbound.createdAt &&
          Boolean(m.text?.trim())
      )
  );

  if (!conversation.isTest && !isWindowOpen(conversation.lastInboundAt)) {
    await applyHandoff(conversationId, organizationId, "ventana");
    return;
  }

  if (lastInbound.text && matchesHandoffIntent(lastInbound.text)) {
    const claimed = await applyHandoff(
      conversationId,
      organizationId,
      "cliente"
    );
    if (claimed) {
      await deliverReply(
        conversation,
        "Claro. Voy a pasar tu conversación a un asesor. La IA queda en pausa mientras te atienden."
      );
    }
    return;
  }

  const inboundText = lastInbound.text;
  const safeGreeting =
    profile.greeting?.trim() ||
    `¡Hola! 👋 Soy ${profile.name || "tu asistente"}. ¿En qué puedo ayudarte?`;

  /**
   * Reactivación = nueva sesión semántica.
   *
   * Si el primer turno de esa sesión es solo un saludo, no hay ninguna razón
   * objetiva para heredar un handoff anterior ni para pedir al modelo que
   * decida si escala: respondemos el saludo configurado y seguimos con IA.
   */
  const firstTurnAfterReset = Boolean(
    conversation.aiContextResetAt &&
      lastInbound.createdAt >= conversation.aiContextResetAt &&
      !history.some(
        (message) =>
          message.direction === "out" &&
          message.createdAt < lastInbound.createdAt
      )
  );
  if (inboundText && firstTurnAfterReset && isBareGreeting(inboundText)) {
    await deliverReply(conversation, safeGreeting);
    return;
  }

  /**
   * IA-W2 — Una confirmación explícita SOLO ejecuta la acción pendiente VIGENTE
   * de esta conversación (tabla `pending_agenda_action`, con expiración y
   * tenant). Sin fila vigente no se ejecuta nada: el estado es del backend, no
   * del modelo, y una confirmación vieja nunca puede disparar una acción nueva.
   */
  if (agendaEnabled() && inboundText && isAffirmativeConfirmation(inboundText)) {
    const pending = await getPendingAction(organizationId, conversationId);
    if (pending) {
      await clearPendingAction(organizationId, conversationId);

      if (pending.action === "cancel") {
        await handleCancellation(conversation);
        return;
      }

      if (pending.action === "book" && pending.startUtc) {
        const turn = await bookSlot({
          organizationId,
          conversationId,
          startUtc: pending.startUtc,
          serviceId: pending.serviceId ?? undefined,
          professionalId: pending.professionalId ?? undefined,
        });
        await deliverReply(conversation, turn.text);
        if (turn.ok) {
          publish(organizationId, {
            type: "conversation.updated",
            data: { conversation: { id: conversationId } },
          });
        }
        return;
      }

      if (pending.action === "reschedule" && pending.startUtc) {
        try {
          const moved = await rescheduleForConversation({
            organizationId,
            conversationId,
            startUtc: pending.startUtc,
          });
          await deliverReply(
            conversation,
            moved.meetingLink
              ? `¡Listo! Reprogramé tu cita para ${moved.label}.\nEnlace: ${moved.meetingLink}`
              : `¡Listo! Reprogramé tu cita para ${moved.label}.`
          );
        } catch (err) {
          if (err instanceof BookingError && err.code === "slot_not_offered") {
            const turn = await offerSlots({
              organizationId,
              conversationId,
              intro: "Ese horario ya no sirve para mover tu cita. Elige otro:",
            });
            await deliverReply(conversation, turn.text);
          } else if (err instanceof BookingError && err.code === "not_found") {
            await deliverReply(
              conversation,
              "No encontré una cita activa para reprogramar."
            );
          } else {
            throw err;
          }
        }
        return;
      }
    }
    // Sin pending vigente la confirmación no habilita nada: sigue el flujo
    // normal y el modelo responde como cualquier otro turno.
  }

  /**
   * IA-1 — Una ORDEN de cancelar NO cancela: abre confirmación pendiente.
   * `matchesCancellationIntent` ya descarta preguntas e hipótesis, así que
   * "¿Puedo cancelar mi cita?" cae al flujo normal (informativo) y nunca
   * llega aquí.
   */
  if (agendaEnabled() && inboundText && matchesCancellationIntent(inboundText)) {
    await setPendingAction({
      organizationId,
      conversationId,
      action: "cancel",
    });
    await deliverReply(
      conversation,
      "Antes de cancelar necesito tu confirmación: ¿confirmas que quieres cancelar tu cita? Responde «sí» y la cancelo."
    );
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
  const documentChunks = await retrieveRelevantDocumentChunks({
    organizationId,
    query: lastInbound.text ?? "",
    maxChunks: 5,
    maxCharacters: 7_500,
  });

  const agenda = agendaEnabled();
  const safeModelReply = (text: string) =>
    enforceAgentCapabilities({ text, agenda });
  const agendaContext = agenda
    ? { settings: await getSettings(organizationId), now: new Date() }
    : null;
  const ofertas = agendaContext
    ? currentOffers(await getOffers(organizationId, conversationId), {
        now: agendaContext.now,
        minNoticeHours: agendaContext.settings.minNoticeHours,
        timezone: agendaContext.settings.timezone,
      })
    : [];
  const mapaDeHuecos = mapaDeHuecosParaModelo(ofertas);

  let todayInfo: { iso: string; label: string } | undefined;
  let scheduleIntent: ScheduleIntent = { kind: "none" };
  let scheduleScope: ScheduleScope | null = null;
  let schedulingSignal = false;
  let expandRequest: ExpandWindow | null = null;
  let businessFact: Parameters<typeof buildAgentSystemPrompt>[0]["businessFact"];
  if (agendaContext) {
    const { settings, now } = agendaContext;
    todayInfo = {
      iso: todayInTz(now, settings.timezone),
      label: todayLabelInTz(now, settings.timezone),
    };
    expandRequest = lastInbound.text ? resolveExpandRequest(lastInbound.text) : null;
    // Una ampliación ("más tarde", "por la tarde", "fin de semana") es señal de
    // agenda por sí misma; "otro día"/"otros horarios" solo cuentan cuando ya
    // hay una oferta vigente en esta conversación (follow-up, no primer turno).
    const expansionSignal =
      expandRequest !== null &&
      (expandRequest !== "next_day" || ofertas.length > 0);
    schedulingSignal = lastInbound.text
      ? hasSchedulingSignal({ text: lastInbound.text, now, timezone: settings.timezone }) ||
        expansionSignal
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

  /**
   * AG-HOLA — El turno ACTUAL debe justificar la agenda.
   *
   * Antes el catálogo de huecos vigentes se inyectaba siempre que existiera una
   * oferta persistida, aunque el mensaje fuera "Hola". Combinado con la regla
   * del prompt que empujaba a "retomar el punto pendiente", el modelo heredaba
   * la intención de una conversación anterior y prometía consultar
   * disponibilidad ante un saludo. Un contexto histórico puede informar la
   * respuesta, pero la operación de agenda necesita señal presente: palabras de
   * agenda, una ampliación explícita, una selección de horario o una
   * confirmación.
   */
  const slotChoiceSignal =
    lastInbound.text !== null &&
    (isBareTimeSelection(lastInbound.text) ||
      hasBookingConfirmation(lastInbound.text));
  const turnTouchesAgenda =
    schedulingSignal || expandRequest !== null || slotChoiceSignal;

  /**
   * Selección horaria determinista: el modelo no decide si "2:20" significa
   * el 14:20 que el backend acaba de mostrar. Se reconstruye la última ventana
   * desde el último mensaje saliente y se cruza únicamente con esas ofertas.
   */
  if (
    agendaContext &&
    lastInbound.text &&
    isBareTimeSelection(lastInbound.text)
  ) {
    const lastOutbound = [...history]
      .reverse()
      .find(
        (message) =>
          message.direction === "out" &&
          message.createdAt < lastInbound.createdAt &&
          Boolean(message.text?.trim())
      );

    if (lastOutbound?.text) {
      const resolution = resolveOfferedTimeSelection({
        text: lastInbound.text,
        offers: ofertas,
        lastOutboundText: lastOutbound.text,
        timezone: agendaContext.settings.timezone,
        shownAt: lastOutbound.createdAt,
      });

      if (resolution.kind === "match") {
        const chosen = findOffered(ofertas, resolution.offer.startUtc);
        const hasCompleteProfessionalContext = Boolean(
          chosen?.serviceId && chosen.professionalId
        );
        const hasPartialProfessionalContext = Boolean(
          chosen && Boolean(chosen.serviceId) !== Boolean(chosen.professionalId)
        );
        const stillAvailable =
          chosen && !hasPartialProfessionalContext
            ? hasCompleteProfessionalContext
              ? await findProfessionalSlot(organizationId, {
                  serviceId: chosen.serviceId!,
                  professionalId: chosen.professionalId!,
                  startUtc: chosen.startUtc,
                  now: agendaContext.now,
                })
              : await findSlot(organizationId, chosen.startUtc, {
                  now: agendaContext.now,
                  settings: agendaContext.settings,
                })
            : null;

        if (chosen && stillAvailable) {
          await setPendingAction({
            organizationId,
            conversationId,
            action: "book",
            startUtc: chosen.startUtc,
            serviceId: chosen.serviceId,
            professionalId: chosen.professionalId,
          });
          await deliverReply(
            conversation,
            `Perfecto. Tengo ${selectedOfferConfirmationLabel(
              chosen.startUtc,
              agendaContext.settings.timezone
            )} disponible. ¿Quieres que agende tu cita?`
          );
          return;
        }

        const turn = await offerSlots({
          organizationId,
          conversationId,
          intro:
            "Ese horario acaba de dejar de estar disponible. Estas son las opciones actuales:",
        });
        await deliverReply(conversation, turn.text);
        return;
      }

      if (resolution.kind === "ambiguous") {
        const choices = resolution.offers
          .map(
            (offer) =>
              `• ${selectedOfferConfirmationLabel(
                offer.startUtc,
                agendaContext.settings.timezone
              )}`
          )
          .join("\n");
        await deliverReply(
          conversation,
          `Encontré más de una opción para esa hora:\n${choices}\n¿Cuál de estas quieres elegir?`
        );
        return;
      }

      if (resolution.kind === "not_found") {
        const turn = await offerSlots({
          organizationId,
          conversationId,
          intro:
            "No encontré esa hora entre las opciones que te mostré. Estas son las opciones actuales:",
        });
        await deliverReply(conversation, turn.text);
        return;
      }
      // Selecciones ordinales ("la primera") conservan el guardarraíl previo:
      // el modelo elige el ISO y findOffered exige coincidencia exacta.
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
        repeatedGreeting,
      }),
    },
    ...buildDocumentKnowledgeMessages(documentChunks),
    ...history
      .filter((m) => m.text)
      .map((m) => ({
        role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
        content: m.text!,
      })),
    ...(mapaDeHuecos && turnTouchesAgenda
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

  // El modelo puede sugerir handoff, pero el backend conserva la última
  // palabra. Si no hay petición explícita ni una regla configurada aplicable,
  // reintentamos una sola vez sin escalado y, si insiste, respondemos sin
  // pausar la conversación.
  if (
    action.action === "handoff" &&
    inboundText &&
    !shouldAllowModelHandoff(inboundText, profile.escalationRules)
  ) {
    const retry = await chatJson(agentActionSchema(agenda), [
      ...messages,
      {
        role: "system",
        content:
          "El handoff NO está autorizado para este turno. Responde al cliente con la información disponible o pide el dato mínimo necesario. Elige una acción distinta de handoff.",
      },
    ]);

    if (retry.ok && retry.data.action !== "handoff") {
      action = retry.data;
    } else {
      action = {
        action: "reply",
        text: "Claro, puedo ayudarte con eso. Dime qué información necesitas.",
      };
    }
  }

  if (action.action === "cancel_booking") {
    if (agenda) await handleCancellation(conversation);
    return;
  }

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
      // IA-3: una oferta base (rango/general/próxima) reinicia el cursor de
      // expansión: la siguiente ampliación vuelve a empezar por la ventana 0.
      await resetOfferCursor(organizationId, conversationId);
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

  // Ampliación explícita de una conversación de agenda ("más tarde", "otro
  // día", "por la tarde", "fin de semana"): se muestra el siguiente conjunto
  // relevante, nunca la agenda completa. No compite con fecha única/rango.
  if (
    agenda &&
    expandRequest &&
    !scheduleScope &&
    (action.action === "reply" || action.action === "offer_slots")
  ) {
    try {
      /**
       * IA-3: cada "otros horarios" avanza la ventana. El modo viene del tipo
       * de ampliación, así que cambiar a "más tarde"/"fin de semana" reinicia
       * el cursor de ese criterio en vez de arrastrar el anterior.
       */
      const cursor = await advanceOfferCursor({
        organizationId,
        conversationId,
        mode: expandRequest,
      });
      const turn = await offerSlots({
        organizationId,
        conversationId,
        expand: expandRequest,
        cursor,
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
      console.error(`[agente] el motor de agenda (ampliación) falló: ${err}`);
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
          // IA-3: una oferta base reinicia el cursor de expansión.
          await resetOfferCursor(organizationId, conversationId);
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
          // Selección de horario ≠ creación de cita: si el cliente solo
          // mencionó/eligió una hora sin confirmar que quiere agendar, NO
          // reservamos todavía — confirmamos el horario elegido y preguntamos.
          if (lastInbound.text && isBareTimeSelection(lastInbound.text)) {
            const chosen = findOffered(ofertas, action.startUtc);
            if (chosen) {
              // IA-W2: queda pendiente el horario elegido, para que un "sí"
              // posterior lo reserve sin depender de que el modelo lo recuerde.
              await setPendingAction({
                organizationId,
                conversationId,
                action: "book",
                startUtc: action.startUtc,
                serviceId: chosen.serviceId,
                professionalId: chosen.professionalId,
              });
              await deliverReply(
                conversation,
                `Perfecto. Tengo ${chosen.label} disponible. ¿Quieres que agende tu cita?`
              );
              return;
            }
            // Sin coincidencia exacta se deja caer al flujo normal: el motor
            // rechazará el instante no ofrecido y re-ofrecerá alternativas reales.
          }
          turn = await bookSlot({
            organizationId,
            conversationId,
            startUtc: action.startUtc,
          });
        } else {
          /**
           * IA-W1 — Mover una cita también es destructivo: una selección desnuda
           * abre confirmación pendiente en vez de reprogramar de inmediato, con
           * el mismo guardarraíl que `book_slot`.
           */
          if (lastInbound.text && isBareTimeSelection(lastInbound.text)) {
            const chosen = findOffered(ofertas, action.startUtc);
            if (chosen) {
              await setPendingAction({
                organizationId,
                conversationId,
                action: "reschedule",
                startUtc: action.startUtc,
              });
              await deliverReply(
                conversation,
                `Tengo ${chosen.label}. ¿Confirmas que mueva tu cita a ese horario?`
              );
              return;
            }
          }
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
        console.warn(
          `[agente] move_stage no se pudo aplicar (${moveResult}); se conserva la conversación con IA`
        );
        await deliverReply(
          conversation,
          action.reply
            ? safeModelReply(action.reply)
            : "Entendido. Puedo seguir ayudándote por aquí."
        );
        return;
      }
      if (moveResult === "moved") {
        publish(organizationId, {
          type: "conversation.updated",
          data: { conversation: { id: conversationId } },
        });
      }
      if (action.reply) {
        await deliverReply(conversation, safeModelReply(action.reply));
      }
      return;
    }
  }

  switch (action.action) {
    case "none":
      return;
    case "reply":
      await deliverReply(conversation, safeModelReply(action.text));
      return;
    case "update_lead": {
      const updated = await appendLeadNote(
        organizationId,
        conversation.contactId,
        action.note
      );
      if (!updated) {
        console.warn(
          "[agente] update_lead no se pudo aplicar; se conserva la conversación con IA"
        );
        await deliverReply(
          conversation,
          action.reply
            ? safeModelReply(action.reply)
            : "Entendido. Puedo seguir ayudándote por aquí."
        );
        return;
      }
      if (action.reply) {
        await deliverReply(conversation, safeModelReply(action.reply));
      }
      return;
    }
    case "handoff": {
      // Un saludo aislado nunca es evidencia suficiente para escalar. El
      // modelo puede proponer handoff, pero esta política determinista tiene la
      // última palabra y evita bucles de "Hola → te paso con un asesor".
      if (inboundText && isBareGreeting(inboundText)) {
        await deliverReply(conversation, safeGreeting);
        return;
      }

      // La transición se reclama ANTES de enviar el farewell. Si varios jobs
      // quedaron en cola por mensajes consecutivos, solo uno puede ganar el
      // handoff y por tanto solo uno envía el mensaje de transferencia.
      const claimed = await applyHandoff(
        conversationId,
        organizationId,
        "modelo"
      );
      if (claimed && action.farewell) {
        await deliverReply(conversation, safeModelReply(action.farewell));
      }
      return;
    }
    case "offer_slots":
    case "book_slot":
    case "reschedule_slot":
    case "cancel_booking":
      return;
  }
}

function isBareGreeting(text: string): boolean {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return /^(hola|holi|hey|buenas|buenos dias|buenas tardes|buenas noches)$/.test(
    normalized
  );
}

type Conversation = typeof schema.conversation.$inferSelect;

async function handleCancellation(conversation: Conversation): Promise<void> {
  try {
    const cancelled = await cancelBookingForConversation({
      organizationId: conversation.organizationId,
      conversationId: conversation.id,
    });
    await deliverReply(
      conversation,
      `Listo, cancelé tu cita: ${cancelled.label}.`
    );
  } catch (err) {
    if (err instanceof BookingError && err.code === "not_found") {
      await deliverReply(
        conversation,
        "No encontré una cita activa para cancelar."
      );
      return;
    }
    console.error(
      `[agente] la cancelación automática falló: ${String(err).slice(0, 500)}`
    );
    const claimed = await applyHandoff(
      conversation.id,
      conversation.organizationId,
      "error"
    );
    if (claimed) {
      await deliverReply(
        conversation,
        "No pude cancelar tu cita automáticamente. Un asesor continuará contigo."
      );
    }
  }
}

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
): Promise<boolean> {
  const db = getDb();
  const updated = await db
    .update(schema.conversation)
    .set({
      aiEnabled: false,
      handoffAt: new Date(),
      handoffReason: reason,
      updatedAt: new Date(),
    })
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId),
        eq(schema.conversation.aiEnabled, true),
        isNull(schema.conversation.handoffAt)
      )
    )
    .returning();
  if (!updated[0]) return false;
  publish(organizationId, {
    type: "conversation.updated",
    data: {
      conversation: {
        id: conversationId,
        aiEnabled: false,
        handoffReason: reason,
      },
    },
  });
  return true;
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
