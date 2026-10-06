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
  acceptsAdvisorOffer,
  closingAcknowledgementReply,
  handoffNotice,
  isBriefAffirmative,
  isClosingAcknowledgement,
  matchesHandoffIntent,
  rejectedHandoffFallback,
  sameNormalizedMessage,
  shouldAllowModelHandoff,
  toneAwareFixedReply,
} from "@/server/ai/handoff";
import { matchesCancellationIntent } from "@/server/agenda/cancel-intent";
import {
  buildAgentSystemPrompt,
  buildDocumentKnowledgeMessages,
  groundedConversationReply,
  needsCompletePriceSource,
} from "@/server/ai/prompts";
import {
  loadCompleteApprovedDocumentChunks,
  retrieveRelevantDocumentChunks,
} from "@/server/kb/documents/retrieval";
import {
  buildCompletePriceSource,
  type CompletePriceSourceResult,
} from "@/server/kb/documents/price-source";
import { agendaEnabled } from "@/server/agenda/flag";
import {
  bookSlot,
  offerGeneralAvailability,
  offerNextAvailable,
  offerRange,
  offerSlots,
  type AgendaTurn,
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
  replaceOffers,
  type OfferedSlot,
} from "@/server/agenda/offers";
import { resolveExpandRequest, type ExpandWindow } from "@/server/agenda/expand";
import {
  hasBookingConfirmation,
  isAffirmativeConfirmation,
  isBareTimeSelection,
  offersShownInLastMessage,
  parseRequestedTime,
  resolveOfferedTimeSelection,
  selectedOfferConfirmationLabel,
} from "@/server/agenda/selection";
import {
  businessHoursLabel,
  freeStartsByDay,
  hhmm,
  isWithinBusinessHours,
  resolveRequestedTime,
} from "@/server/agenda/time-request";
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
import { computeAvailability, findSlot } from "@/server/agenda/availability";
import { findProfessionalSlot } from "@/server/agenda/professional-availability";
import {
  dayIsoInTz,
  dayLabelInTz,
  labelInTz,
  timeInTz,
  todayInTz,
  todayLabelInTz,
  zonedWallClockToUtc,
} from "@/lib/time/slots";
import {
  capitalize,
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
import {
  createAgentRun,
  finishAgentRun,
  hasActiveAgentRun,
  recordAgentAction,
  recordAgentEvidence,
  withAgentRun,
} from "@/server/ai/observability";

async function recordOfferedSlots(
  organizationId: string,
  conversationId: string,
  turn: AgendaTurn
): Promise<void> {
  if (!hasActiveAgentRun()) return;
  const slots = await getOffers(organizationId, conversationId);
  await recordAgentEvidence([
    {
      sourceType: "agenda",
      sourceId: conversationId,
      snapshot: {
        response: turn.text,
        offeredSlots: slots.map((slot) => ({
          startUtc: slot.startUtc,
          label: slot.label,
          serviceId: slot.serviceId,
          professionalId: slot.professionalId,
        })),
      },
    },
  ]);
  await recordAgentAction({
    action: "offer_slots",
    success: turn.ok,
    status: turn.ok ? "completed" : "rejected",
    entityType: "conversation",
    entityId: conversationId,
    payload: {
      slotCount: slots.length,
      startUtc: slots.map((slot) => slot.startUtc),
    },
  });
}

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

  // Si el turno ya corre dentro de un AgentRun, reutiliza ese contexto.
  // Evita crear runs anidados y permite ejecutar el core de forma aislada.
  if (hasActiveAgentRun()) {
    return runAgentTurnCore(conversationId, expectedOrganizationId);
  }

  const db = getDb();
  const conversations = await db
    .select({ organizationId: schema.conversation.organizationId })
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
  const organizationId = conversations[0]?.organizationId;
  if (!organizationId) return;
  const inbound = await db
    .select({ id: schema.message.id })
    .from(schema.message)
    .where(
      scoped(
        schema.message.organizationId,
        organizationId,
        eq(schema.message.conversationId, conversationId),
        eq(schema.message.direction, "in")
      )
    )
    .orderBy(desc(schema.message.createdAt), desc(schema.message.id))
    .limit(1);
  const run = await createAgentRun({
    organizationId,
    conversationId,
    inboundMessageId: inbound[0]?.id ?? null,
    provider: "openrouter",
  });
  try {
    await withAgentRun(run, () =>
      runAgentTurnCore(conversationId, expectedOrganizationId)
    );
    await finishAgentRun(run, { status: "completed" });
  } catch (error) {
    await finishAgentRun(run, { status: "failed", error });
    throw error;
  }
}

async function runAgentTurnCore(
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

  const lastAgentTextBeforeInbound =
    [...history]
      .reverse()
      .find(
        (message) =>
          message.direction === "out" &&
          message.createdAt < lastInbound.createdAt &&
          Boolean(message.text?.trim())
      )?.text ?? null;

  // Pedir una persona y aceptar con un "sí" la oferta explícita de asesor que
  // el agente acaba de hacer son la misma petición del cliente.
  if (
    lastInbound.text &&
    (matchesHandoffIntent(lastInbound.text) ||
      acceptsAdvisorOffer(lastInbound.text, lastAgentTextBeforeInbound))
  ) {
    const claimed = await applyHandoff(
      conversationId,
      organizationId,
      "cliente"
    );
    if (claimed) {
      await deliverReply(
        conversation,
        handoffNotice(profile.tone)
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
        await recordAgentAction({
          action: "book_slot",
          success: turn.ok,
          status: turn.ok ? "completed" : "rejected",
          payload: { startUtc: pending.startUtc },
        });
        await deliverReply(
          conversation,
          toneAwareFixedReply(turn.text, profile.tone)
        );
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
          await recordAgentAction({
            action: "reschedule_slot",
            entityType: "booking",
            entityId: pending.bookingId,
            payload: { startUtc: pending.startUtc },
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
            await recordOfferedSlots(organizationId, conversationId, turn);
            await deliverReply(
              conversation,
              toneAwareFixedReply(turn.text, profile.tone)
            );
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
    await recordAgentAction({ action: "set_pending_cancel" });
    await deliverReply(
      conversation,
      "Antes de cancelar necesito tu confirmación: ¿confirmas que quieres cancelar tu cita? Responde «sí» y la cancelo."
    );
    return;
  }

  if (
    inboundText &&
    isClosingAcknowledgement(inboundText, lastAgentTextBeforeInbound)
  ) {
    await deliverReply(
      conversation,
      closingAcknowledgementReply(profile.tone)
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
  // Los dos mensajes previos del cliente mantienen el tema en follow-ups como
  // "¿Qué incluye cada una?", que por sí solos no nombran ningún servicio.
  const previousInboundTexts = history
    .filter(
      (message) =>
        message.direction === "in" &&
        message.id !== lastInbound.id &&
        Boolean(message.text?.trim())
    )
    .slice(-2)
    .map((message) => message.text!);
  const purchaseIntentRetrievalHint = lastInbound.text &&
    /\b(?:quiero|quisiera|necesito)\s+(?:avanzar|contratar|comprar|empezar|iniciar)(?:\s+(?:hoy|ya|ahora))?\b/i.test(
      lastInbound.text.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    )
      ? "agendar cita solicitar nombre completo numero telefono servicio motivo consulta"
      : "";
  const documentChunks = await retrieveRelevantDocumentChunks({
    organizationId,
    query: lastInbound.text ?? "",
    contextQuery: [...previousInboundTexts, purchaseIntentRetrievalHint]
      .filter(Boolean)
      .join("\n"),
    maxChunks: 5,
    maxCharacters: 7_500,
  });
  const knowledgeText = [
    ...kb.map((entry) =>
      entry.kind === "qa"
        ? `${entry.question ?? ""}\n${entry.answer ?? ""}`
        : entry.content ?? ""
    ),
    ...documentChunks.map((chunk) => chunk.content),
  ]
    .filter(Boolean)
    .join("\n\n");
  let completePriceSource: CompletePriceSourceResult | undefined;
  if (inboundText && needsCompletePriceSource(inboundText)) {
    try {
      const documents = await loadCompleteApprovedDocumentChunks({ organizationId });
      if (!documents.complete) {
        console.warn(
          `[agente] price_source_fallback reason=${documents.reason} documentId=${documents.documentId}`
        );
        completePriceSource = {
          complete: false,
          lines: [],
          reason: documents.reason,
          documentId: documents.documentId,
        };
      } else {
        const manualEntries = kb.map((entry) => ({
          id: entry.id,
          text:
            entry.kind === "qa"
              ? `${entry.question ?? ""}\n${entry.answer ?? ""}`
              : entry.content ?? "",
        }));
        completePriceSource = buildCompletePriceSource({
          organizationId,
          manualEntries,
          documentChunks: documents.chunks,
        });
        if (!completePriceSource.complete) {
          console.warn(
            `[agente] price_source_fallback reason=${completePriceSource.reason} documentId=${completePriceSource.documentId}`
          );
        }
      }
    } catch {
      completePriceSource = {
        complete: false,
        lines: [],
        reason: "load_error",
        documentId: "all",
      };
      console.warn("[agente] price_source_fallback reason=load_error documentId=all");
    }
  }
  const customerHistoryText = history
    .filter((message) => message.direction === "in" && message.text)
    .map((message) => message.text)
    .join("\n");
  const groundedReply = inboundText
    ? groundedConversationReply({
        inboundText,
        customerHistoryText,
        knowledgeText,
        completePriceSource,
        tone: profile.tone,
        lastAgentText: lastAgentTextBeforeInbound,
        conversation: history
          .filter((message) => Boolean(message.text?.trim()))
          .map((message) => ({
            role: message.direction === "in" ? ("customer" as const) : ("agent" as const),
            text: message.text!,
          })),
      })
    : null;
  const agenda = agendaEnabled();
  const safeModelReply = (text: string) =>
    enforceAgentCapabilities({ text, agenda });
  const safeQualityReply = (text: string) => {
    const repeatsInbound = Boolean(
      inboundText && sameNormalizedMessage(text, inboundText)
    );
    const repeatsPrevious = Boolean(
      lastAgentTextBeforeInbound &&
        sameNormalizedMessage(text, lastAgentTextBeforeInbound)
    );
    if (
      inboundText &&
      (repeatsInbound || repeatsPrevious) &&
      (isBriefAffirmative(inboundText) ||
        isClosingAcknowledgement(inboundText, lastAgentTextBeforeInbound))
    ) {
      return closingAcknowledgementReply(profile.tone);
    }
    return safeModelReply(text);
  };
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

  /**
   * La última lista de horarios que el cliente VIO. Se busca en los últimos
   * mensajes salientes (no solo el último): tras una pregunta de aclaración
   * ("¿las 16:00 o la opción 4?") "la cuarta" sigue apuntando a esa lista.
   */
  const shownContext = (() => {
    if (!agendaContext || ofertas.length === 0) return null;
    const outbound = history
      .filter(
        (message) =>
          message.direction === "out" &&
          message.createdAt < lastInbound.createdAt &&
          Boolean(message.text?.trim())
      )
      .reverse()
      .slice(0, 3);
    for (const message of outbound) {
      const shownOffers = offersShownInLastMessage({
        offers: ofertas,
        lastOutboundText: message.text!,
        timezone: agendaContext.settings.timezone,
        shownAt: message.createdAt,
      });
      if (shownOffers.length > 0) {
        const tz = agendaContext.settings.timezone;
        const days = [
          ...new Set(shownOffers.map((offer) => dayIsoInTz(new Date(offer.startUtc), tz))),
        ];
        const referenceDay = days[0]!;
        const lastShownTime = shownOffers
          .filter((offer) => dayIsoInTz(new Date(offer.startUtc), tz) === referenceDay)
          .map((offer) => timeInTz(offer.startUtc, tz))
          .sort()
          .at(-1);
        return { message, shownOffers, days, referenceDay, lastShownTime };
      }
    }
    return null;
  })();

  await recordAgentEvidence([
    {
      sourceType: "conversation_context",
      sourceId: conversationId,
      snapshot: {
        messages: history.map((message) => ({
          id: message.id,
          direction: message.direction,
          type: message.type,
          text: message.text,
        })),
      },
    },
    {
      sourceType: "agent_profile",
      sourceId: profile.id,
      snapshot: {
        name: profile.name,
        tone: profile.tone,
        instructions: profile.instructions,
        escalationRules: profile.escalationRules,
      },
    },
    ...kb.map((entry) => ({
      sourceType: "kb_entry" as const,
      sourceId: entry.id,
      snapshot: {
        kind: entry.kind,
        question: entry.question,
        answer: entry.answer,
        content: entry.content,
      },
    })),
    ...documentChunks.map((chunk) => ({
      sourceType: "document_chunk" as const,
      sourceId: chunk.id,
      score: chunk.score,
      snapshot: {
        documentId: chunk.documentId,
        content: chunk.content,
        position: chunk.position,
        page: chunk.page,
      },
    })),
    ...(agendaContext
      ? [
          {
            sourceType: "agenda" as const,
            sourceId: conversationId,
            snapshot: {
              timezone: agendaContext.settings.timezone,
              minNoticeHours: agendaContext.settings.minNoticeHours,
              offeredSlots: ofertas.map((slot) => ({
                startUtc: slot.startUtc,
                label: slot.label,
                serviceId: slot.serviceId,
                professionalId: slot.professionalId,
              })),
            },
          },
        ]
      : []),
  ]);

  if (groundedReply) {
    await deliverReply(conversation, groundedReply);
    return;
  }

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
   * Hora pedida con palabras ("4 de la tarde", "a las 4 y media", "16:00") o
   * número suelto ("4"), con una lista de horarios ya mostrada.
   *
   * La hora se comprueba contra TODA la disponibilidad del día mostrado, no
   * solo contra los horarios visibles: libre → selección pendiente de
   * confirmar (nunca se agenda directo); ocupada o fuera de horario → se dice
   * y se ofrecen los huecos libres más cercanos del mismo día. Un número
   * suelto es ambiguo (¿opción 4 u hora 4?) y se pregunta sin el modelo.
   * "La cuarta" y similares siguen por la selección de la lista mostrada.
   *
   * Con contexto de servicio/profesional se conserva el camino anterior: la
   * disponibilidad de ese motor no está en el catálogo general.
   */
  const requestedTime =
    agendaContext && lastInbound.text && !hasBookingConfirmation(lastInbound.text)
      ? parseRequestedTime(lastInbound.text)
      : null;
  if (
    agendaContext &&
    requestedTime &&
    shownContext &&
    !shownContext.shownOffers.some((offer) => offer.serviceId || offer.professionalId)
  ) {
    const { settings, now } = agendaContext;
    const tz = settings.timezone;
    const shown = shownContext.shownOffers;

    if (requestedTime.kind === "bare_number" && requestedTime.value >= 1) {
      const option = shown[requestedTime.value - 1];
      if (option) {
        // La lectura como hora: la que cae dentro del horario de atención.
        const hourReading = [requestedTime.value, requestedTime.value + 12]
          .filter((hour) => hour <= 23)
          .map((hour) => hour * 60)
          .find((minute) =>
            isWithinBusinessHours(shownContext.referenceDay, minute, settings.weeklyHours, tz)
          );
        const optionLabel = `la opción ${requestedTime.value} (${timeInTz(option.startUtc, tz)})`;
        await deliverReply(
          conversation,
          hourReading !== undefined
            ? `Para confirmar: ¿las ${hhmm(hourReading)} o ${optionLabel}?`
            : `Para confirmar: ¿${optionLabel}?`
        );
        return;
      }
    }

    const candidates =
      requestedTime.kind === "time"
        ? requestedTime.candidates
        : requestedTime.value >= 1 && requestedTime.value <= 23
          ? requestedTime.value < 12
            ? [requestedTime.value * 60, (requestedTime.value + 12) * 60]
            : [requestedTime.value * 60]
          : [];

    if (candidates.length > 0) {
      // Libres = catálogo persistido ∪ disponibilidad fresca de esos días.
      let freeStarts = ofertas.map((offer) => offer.startUtc);
      try {
        const sortedDays = [...shownContext.days].sort();
        const fresh = await computeAvailability(organizationId, {
          settings,
          now,
          fromISO: sortedDays[0],
          toISO: sortedDays.at(-1),
        });
        if (Array.isArray(fresh)) {
          freeStarts = [...freeStarts, ...fresh.map((slot) => slot.startUtc)];
        }
      } catch (err) {
        console.warn(`[agente] disponibilidad del día no disponible: ${err}`);
      }

      const resolve = () =>
        resolveRequestedTime({
          candidates,
          days: shownContext.days,
          freeByDay: freeStartsByDay(freeStarts, shownContext.days, tz),
          weeklyHours: settings.weeklyHours,
          timezone: tz,
        });
      let resolution = resolve();

      if (resolution?.kind === "free") {
        const startUtc = resolution.startUtc;
        const stillAvailable = await findSlot(organizationId, startUtc, { now, settings });
        if (stillAvailable) {
          if (!findOffered(ofertas, startUtc)) {
            // Libre pero fuera del catálogo persistido: se añade para que la
            // confirmación posterior pase la regla "solo se reserva lo ofrecido".
            const added: OfferedSlot = { startUtc, label: labelInTz(startUtc, tz) };
            await replaceOffers(organizationId, conversationId, [...ofertas, added]);
          }
          await setPendingAction({
            organizationId,
            conversationId,
            action: "book",
            startUtc,
            serviceId: null,
            professionalId: null,
          });
          await recordAgentAction({
            action: "set_pending_book",
            payload: { startUtc },
          });
          await deliverReply(
            conversation,
            toneAwareFixedReply(
              `Perfecto. Tengo ${selectedOfferConfirmationLabel(startUtc, tz)} disponible. ¿Quieres que agende tu cita?`,
              profile.tone
            )
          );
          return;
        }
        // Se ocupó entre la oferta y ahora: se trata como ocupada.
        freeStarts = freeStarts.filter(
          (slot) => new Date(slot).toISOString() !== startUtc
        );
        resolution = resolve();
      }

      if (resolution?.kind === "multiple") {
        const choices = resolution.startUtcs
          .map((startUtc) => `• ${selectedOfferConfirmationLabel(startUtc, tz)}`)
          .join("\n");
        await deliverReply(
          conversation,
          toneAwareFixedReply(
            `Encontré más de una opción para esa hora:\n${choices}\n¿Cuál de estas quieres elegir?`,
            profile.tone
          )
        );
        return;
      }

      if (resolution && (resolution.kind === "taken" || resolution.kind === "outside_hours")) {
        const requested = hhmm(resolution.minute);
        const heading =
          resolution.kind === "outside_hours"
            ? `Las ${requested} están fuera del horario de atención${
                businessHoursLabel(resolution.day, settings.weeklyHours, tz)
                  ? ` (${businessHoursLabel(resolution.day, settings.weeklyHours, tz)})`
                  : ""
              }.`
            : `${capitalize(
                selectedOfferConfirmationLabel(
                  zonedWallClockToUtc(resolution.day, requested, tz)!.toISOString(),
                  tz
                )
              )} no está disponible.`;
        if (resolution.nearest.length > 0) {
          const dayTitle = capitalize(dayLabelInTz(resolution.nearest[0]!, tz, now));
          const list = resolution.nearest.map((startUtc) => `• ${timeInTz(startUtc, tz)}`).join("\n");
          await deliverReply(
            conversation,
            toneAwareFixedReply(
              `${heading} Los horarios libres más cercanos ese día son:\n${dayTitle}\n${list}\n¿Cuál te funciona mejor?`,
              profile.tone
            )
          );
          return;
        }
        const turn = await offerSlots({
          organizationId,
          conversationId,
          intro: "Ese día ya no tengo horarios libres. Estas son mis próximas opciones:",
        });
        await recordOfferedSlots(organizationId, conversationId, turn);
        await deliverReply(
          conversation,
          toneAwareFixedReply(`${heading}\n${turn.text}`, profile.tone)
        );
        return;
      }
    }
  }

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
    const lastOutbound =
      shownContext?.message ??
      [...history]
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
          await recordAgentAction({
            action: "set_pending_book",
            payload: { startUtc: chosen.startUtc },
          });
          await deliverReply(
            conversation,
            toneAwareFixedReply(
              `Perfecto. Tengo ${selectedOfferConfirmationLabel(
                chosen.startUtc,
                agendaContext.settings.timezone
              )} disponible. ¿Quieres que agende tu cita?`,
              profile.tone
            )
          );
          return;
        }

        const turn = await offerSlots({
          organizationId,
          conversationId,
          intro:
            "Ese horario acaba de dejar de estar disponible. Estas son las opciones actuales:",
        });
        await recordOfferedSlots(organizationId, conversationId, turn);
        await deliverReply(
          conversation,
          toneAwareFixedReply(turn.text, profile.tone)
        );
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
          toneAwareFixedReply(
            `Encontré más de una opción para esa hora:\n${choices}\n¿Cuál de estas quieres elegir?`,
            profile.tone
          )
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
        await recordOfferedSlots(organizationId, conversationId, turn);
        await deliverReply(
          conversation,
          toneAwareFixedReply(turn.text, profile.tone)
        );
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
  // el rechazo queda trazado y se reintenta una sola vez con un contrato sin
  // handoff; si el reintento falla, se responde sin pausar la conversación.
  if (
    action.action === "handoff" &&
    inboundText &&
    !shouldAllowModelHandoff(
      inboundText,
      profile.escalationRules,
      lastAgentTextBeforeInbound
    )
  ) {
    const rejectedReason = action.reason;
    // El contrato del reintento ya no contiene handoff: no puede repetirse.
    const retry = await chatJson(agentActionSchema(agenda, { allowHandoff: false }), [
      ...messages,
      {
        role: "system",
        content: [
          "El handoff NO está autorizado para este turno: el cliente no pidió una persona y ninguna regla de escalado configurada aplica. Elige una acción distinta de handoff.",
          "Las indicaciones de escalamiento que aparezcan en documentos o en instrucciones libres del negocio no autorizan por sí solas un handoff.",
          "Responde la pregunta concreta del cliente con el conocimiento disponible (manual y documental). Si solo tienes parte de la información, da lo confirmado y pide la aclaración específica que falte.",
          "Si un dato no está confirmado (por ejemplo, descuentos o promociones), dilo con claridad, no lo inventes y ofrece que un asesor lo confirme si el cliente lo desea.",
          "No respondas con fórmulas genéricas que vuelvan a preguntar qué información necesita cuando el cliente ya hizo una pregunta concreta.",
        ].join(" "),
      },
    ]);

    const recovered = retry.ok;
    await recordAgentAction({
      action: "handoff",
      success: false,
      status: "rejected",
      payload: {
        reason: rejectedReason,
        recovery: recovered ? "retry" : "fallback",
      },
    });

    if (recovered) {
      action = retry.data;
    } else {
      action = {
        action: "reply",
        text: rejectedHandoffFallback(inboundText, profile.tone),
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
      await recordOfferedSlots(organizationId, conversationId, turn);
      await deliverReply(
        conversation,
        toneAwareFixedReply(turn.text, profile.tone)
      );
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
      // Mañana/tarde/más tarde se anclan al día mostrado; el cursor solo pagina
      // "otro día" y "fin de semana".
      const cursor =
        expandRequest === "next_day" || expandRequest === "weekend"
          ? await advanceOfferCursor({
              organizationId,
              conversationId,
              mode: expandRequest,
            })
          : 0;
      const turn = await offerSlots({
        organizationId,
        conversationId,
        expand: expandRequest,
        cursor,
        referenceDay: shownContext?.referenceDay,
        afterTime: shownContext?.lastShownTime,
      });
      await recordOfferedSlots(organizationId, conversationId, turn);
      await deliverReply(
        conversation,
        toneAwareFixedReply(turn.text, profile.tone)
      );
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
      const attemptedAction = action.action;
      try {
        let turn;
        let observedAction = attemptedAction;
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
              await recordAgentAction({
                action: "set_pending_book",
                payload: { startUtc: action.startUtc },
              });
              await deliverReply(
                conversation,
                toneAwareFixedReply(
                  `Perfecto. Tengo ${chosen.label} disponible. ¿Quieres que agende tu cita?`,
                  profile.tone
                )
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
              await recordAgentAction({
                action: "set_pending_reschedule",
                payload: { startUtc: action.startUtc },
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
              await recordAgentAction({
                action: "reschedule_slot",
                success: false,
                status: "rejected",
                payload: { reason: err.code, startUtc: action.startUtc },
              });
              observedAction = "offer_slots";
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
              await recordAgentAction({
                action: "reschedule_slot",
                success: false,
                status: "rejected",
                payload: { reason: err.code, startUtc: action.startUtc },
              });
              observedAction = "offer_slots";
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

        if (observedAction === "offer_slots") {
          await recordOfferedSlots(organizationId, conversationId, turn);
        } else {
          await recordAgentAction({
            action: observedAction,
            success: turn.ok,
            status: turn.ok ? "completed" : "rejected",
            payload:
              "startUtc" in action ? { startUtc: action.startUtc } : {},
          });
        }
        await deliverReply(
          conversation,
          toneAwareFixedReply(turn.text, profile.tone)
        );
        if (turn.ok) {
          publish(organizationId, {
            type: "conversation.updated",
            data: { conversation: { id: conversationId } },
          });
        }
        return;
      } catch (err) {
        await recordAgentAction({
          action: attemptedAction,
          success: false,
          status: "failed",
          payload: { error: String(err) },
        });
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
        await recordAgentAction({
          action: "move_stage",
          success: false,
          status: "rejected",
          entityType: "pipeline_stage",
          entityId: stage.id,
          payload: { reason: moveResult },
        });
        console.warn(
          `[agente] move_stage no se pudo aplicar (${moveResult}); se conserva la conversación con IA`
        );
        await deliverReply(
          conversation,
          action.reply
            ? safeQualityReply(action.reply)
            : "Entendido. Puedo seguir ayudándote por aquí."
        );
        return;
      }
      if (moveResult === "moved") {
        await recordAgentAction({
          action: "move_stage",
          entityType: "pipeline_stage",
          entityId: stage.id,
        });
        publish(organizationId, {
          type: "conversation.updated",
          data: { conversation: { id: conversationId } },
        });
      }
      if (action.reply) {
        await deliverReply(conversation, safeQualityReply(action.reply));
      }
      return;
    }
  }

  switch (action.action) {
    case "none":
      return;
    case "reply":
      await deliverReply(conversation, safeQualityReply(action.text));
      return;
    case "update_lead": {
      const updated = await appendLeadNote(
        organizationId,
        conversation.contactId,
        action.note
      );
      if (!updated) {
        await recordAgentAction({
          action: "update_lead",
          success: false,
          status: "rejected",
          entityType: "contact",
          entityId: conversation.contactId,
        });
        console.warn(
          "[agente] update_lead no se pudo aplicar; se conserva la conversación con IA"
        );
        await deliverReply(
          conversation,
          action.reply
            ? safeQualityReply(action.reply)
            : "Entendido. Puedo seguir ayudándote por aquí."
        );
        return;
      }
      await recordAgentAction({
        action: "update_lead",
        entityType: "contact",
        entityId: conversation.contactId,
      });
      if (action.reply) {
        await deliverReply(conversation, safeQualityReply(action.reply));
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
        await deliverReply(conversation, safeQualityReply(action.farewell));
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
    await recordAgentAction({
      action: "cancel_booking",
      entityType: "conversation",
      entityId: conversation.id,
    });
    await deliverReply(
      conversation,
      `Listo, cancelé tu cita: ${cancelled.label}.`
    );
  } catch (err) {
    if (err instanceof BookingError && err.code === "not_found") {
      await recordAgentAction({
        action: "cancel_booking",
        success: false,
        status: "rejected",
        entityType: "conversation",
        entityId: conversation.id,
        payload: { reason: err.code },
      });
      await deliverReply(
        conversation,
        "No encontré una cita activa para cancelar."
      );
      return;
    }
    await recordAgentAction({
      action: "cancel_booking",
      success: false,
      status: "failed",
      entityType: "conversation",
      entityId: conversation.id,
      payload: { error: String(err) },
    });
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
): Promise<string | null> {
  let messageId: string | null = null;
  if (conversation.isTest) {
    messageId = await persistTestOutbound(conversation, text);
    await recordAgentAction({
      action: "reply",
      outboundMessageId: messageId,
      entityType: "message",
      entityId: messageId,
    });
    return messageId;
  }
  try {
    const sent = await sendText({
      conversationId: conversation.id,
      organizationId: conversation.organizationId,
      text,
      aiGenerated: true,
    });
    messageId = sent.messageId;
    await recordAgentAction({
      action: "reply",
      outboundMessageId: messageId,
      entityType: "message",
      entityId: messageId,
    });
    return messageId;
  } catch (err) {
    if (err instanceof SendError && err.code === "window_closed") {
      await applyHandoff(
        conversation.id,
        conversation.organizationId,
        "ventana"
      );
      return null;
    }
    throw err;
  }
}

async function persistTestOutbound(
  conversation: Conversation,
  text: string
): Promise<string> {
  const db = getDb();
  const messageId = newId("message");
  await db.insert(schema.message).values({
    id: messageId,
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
  return messageId;
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
  if (!updated[0]) {
    await recordAgentAction({
      action: "handoff",
      success: false,
      status: "rejected",
      entityType: "conversation",
      entityId: conversationId,
      payload: { reason },
    });
    return false;
  }
  await recordAgentAction({
    action: "handoff",
    entityType: "conversation",
    entityId: conversationId,
    payload: { reason },
  });
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
