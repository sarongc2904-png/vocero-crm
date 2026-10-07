import { asc, desc, eq, gte, inArray, isNull } from "drizzle-orm";
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
  listActiveBookingsForConversation,
  rescheduleForConversation,
} from "@/server/agenda/service";
import {
  bookingChoiceList,
  matchesRescheduleIntent,
  resolveBookingReference,
  type ActiveBookingRef,
} from "@/server/agenda/booking-reference";
import {
  currentOffers,
  findOffered,
  getOffers,
  mapaDeHuecosParaModelo,
  type OfferedSlot,
} from "@/server/agenda/offers";
import { resolveExpandRequest, type ExpandWindow } from "@/server/agenda/expand";
import {
  classifyConfirmation,
  confirmsAgendaAction,
  hasBookingConfirmation,
  isBareTimeSelection,
  resolveOfferedTimeSelection,
  selectedOfferConfirmationLabel,
} from "@/server/agenda/selection";
import {
  clearPendingAction,
  consumePendingAction,
  getPendingAction,
  setPendingAction,
  type PendingAgendaAction,
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
  // El último mensaje saliente antes de este entrante, sea del agente o de un
  // operador: una pendiente solo responde a la pregunta que sigue siendo ésta.
  const lastOutboundBeforeInbound =
    [...history]
      .reverse()
      .find(
        (message) =>
          message.direction === "out" && message.createdAt < lastInbound.createdAt
      ) ?? null;
  const agendaAsk: AgendaAsk = { conversation, tone: profile.tone };

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
   * IA-W2 — Una confirmación explícita SOLO ejecuta la acción pendiente
   * EJECUTABLE de esta conversación (tabla `pending_agenda_action`). El estado
   * es del backend, no del modelo: una confirmación vieja nunca puede disparar
   * una acción nueva.
   *
   * Este bloque es el ÚNICO que crea, mueve o cancela una cita desde la
   * conversación. La acción se toma con `consumePendingAction` (DELETE …
   * RETURNING), que en la misma sentencia exige que siga vigente, que esté
   * ligada al ÚLTIMO mensaje saliente (la pregunta que la creó: si después
   * escribió un operador o el agente habló de otra cosa, el "sí" ya no
   * contesta a esa pregunta), que ESTE "sí" haya llegado después de la
   * pregunta, que la IA siga encendida sin handoff ni reinicio de sesión y que
   * cancelar o reprogramar traiga su cita exacta. Dos "sí" concurrentes no la
   * ejecutan dos veces.
   *
   * Si ejecutar falla, el cliente recibe siempre una respuesta determinista
   * (y, ante un error inesperado, handoff); el error nunca vuelve al job, cuyo
   * reintento haría improvisar al modelo sobre un "sí" ya consumido.
   *
   * Cualquier otro mensaje la descarta (cambio de tema, otra hora, negativa,
   * duda, un audio, una imagen, un sticker) y sigue su flujo normal: si el
   * cliente preguntó algo ("sí, ¿y cuánto cuesta?"), se le responde.
   * Cancelar y reprogramar exigen un "sí" claro: "ok", "gracias" o 👍 no bastan.
   */
  if (agendaEnabled() && !inboundText) {
    await clearPendingAction(organizationId, conversationId);
  }
  const confirmation =
    agendaEnabled() && inboundText ? classifyConfirmation(inboundText) : null;
  if (confirmation === "confirm") {
    const pending = await consumePendingAction(organizationId, conversationId, lastInbound.id);
    if (!pending) {
      // No hay pendiente, venció o ya no responde a la última pregunta: se
      // descarta y el "sí" sigue el flujo normal sin habilitar nada.
      await clearPendingAction(organizationId, conversationId);
    } else if (confirmsAgendaAction(inboundText!, pending.action)) {
      if (pending.action === "cancel" && pending.bookingId) {
        await handleCancellation(conversation, pending.bookingId, profile.tone);
        return;
      }

      if (pending.action === "book" && pending.startUtc) {
        let executed = false;
        try {
          const turn = await bookSlot({
            organizationId,
            conversationId,
            startUtc: pending.startUtc,
            serviceId: pending.serviceId ?? undefined,
            professionalId: pending.professionalId ?? undefined,
          });
          executed = turn.ok;
          await recordAgentAction({
            action: "book_slot",
            success: turn.ok,
            status: turn.ok ? "completed" : "rejected",
            payload: { startUtc: pending.startUtc },
          });
          await deliverAgendaReply(
            conversation,
            toneAwareFixedReply(turn.text, profile.tone)
          );
          if (turn.ok) {
            publish(organizationId, {
              type: "conversation.updated",
              data: { conversation: { id: conversationId } },
            });
          }
        } catch (err) {
          // Error inesperado (BD, proveedor…): `bookSlot` ya responde los
          // errores de agenda conocidos (horario ocupado o ya no ofrecido).
          await failPendingAction(conversation, "book", err, profile.tone, executed);
        }
        return;
      }

      if (pending.action === "reschedule" && pending.startUtc && pending.bookingId) {
        let executed = false;
        try {
          const moved = await rescheduleForConversation({
            organizationId,
            conversationId,
            startUtc: pending.startUtc,
            bookingId: pending.bookingId,
          });
          executed = true;
          await recordAgentAction({
            action: "reschedule_slot",
            entityType: "booking",
            entityId: pending.bookingId,
            payload: { startUtc: pending.startUtc },
          });
          await deliverAgendaReply(
            conversation,
            toneAwareFixedReply(
              moved.meetingLink
                ? `¡Listo! Reprogramé tu cita para ${moved.label}.\nEnlace: ${moved.meetingLink}`
                : `¡Listo! Reprogramé tu cita para ${moved.label}.`,
              profile.tone
            )
          );
        } catch (err) {
          if (
            !executed &&
            err instanceof BookingError &&
            (err.code === "slot_not_offered" || err.code === "slot_taken")
          ) {
            // El horario ya no sirve o se acaba de ocupar: se ofrecen
            // alternativas y, al elegir otra, se vuelve a preguntar.
            await reofferReschedule(conversation, err.code, profile.tone);
          } else if (
            !executed &&
            err instanceof BookingError &&
            (err.code === "not_found" || err.code === "invalid")
          ) {
            await deliverAgendaReply(
              conversation,
              toneAwareFixedReply(
                "No encontré una cita activa para reprogramar.",
                profile.tone
              )
            );
          } else {
            await failPendingAction(conversation, "reschedule", err, profile.tone, executed);
          }
        }
        return;
      }
    } else if (await askToMoveInstead(agendaAsk, pending, inboundText!)) {
      // "sí, muévela" ante "¿agendo otra cita?": mover la que ya tiene.
      return;
    }
    // "ok", "gracias" o 👍 ante una cancelación o reprogramación: la pendiente
    // ya se consumió sin ejecutarse y el turno sigue normal.
  } else if (confirmation) {
    // "muévela" ante "¿agendo otra cita?": la pendiente de reserva se vuelve
    // una pregunta de mover la cita que ya tiene.
    const toMove = wantsToMoveInstead(inboundText!)
      ? await getPendingAction(organizationId, conversationId)
      : null;
    if (
      toMove &&
      toMove.id === lastOutboundBeforeInbound?.id &&
      (await askToMoveInstead(agendaAsk, toMove, inboundText!))
    ) {
      return;
    }
    /**
     * "¿Cuál de tus citas?": si el agente acaba de listar las citas, la
     * respuesta ("la segunda", "la del lunes") elige una y se pide la
     * confirmación nombrándola. Cualquier otra cosa descarta la pendiente.
     */
    const choice = isBookingChoiceQuestion(lastOutboundBeforeInbound?.text)
      ? await getPendingAction(organizationId, conversationId)
      : null;
    if (
      choice &&
      choice.action !== "book" &&
      !choice.bookingId &&
      choice.id === lastOutboundBeforeInbound?.id
    ) {
      const active = await listActiveBookingsForConversation({
        organizationId,
        conversationId,
      });
      const chosen = resolveBookingReference(inboundText!, active, { listed: true });
      if (chosen && choice.action === "cancel") {
        await confirmCancellation(agendaAsk, chosen);
        return;
      }
      if (chosen && choice.action === "reschedule" && choice.startUtc) {
        await confirmReschedule(agendaAsk, chosen, {
          startUtc: choice.startUtc,
          serviceId: choice.serviceId,
          professionalId: choice.professionalId,
        });
        return;
      }
    }
    await clearPendingAction(organizationId, conversationId);
  }

  /**
   * IA-1 — Una ORDEN de cancelar NO cancela: abre confirmación pendiente
   * nombrando la cita (y, con varias, pregunta cuál). `matchesCancellationIntent`
   * ya descarta preguntas e hipótesis, así que "¿Puedo cancelar mi cita?" cae
   * al flujo normal (informativo) y nunca llega aquí.
   */
  if (agendaEnabled() && inboundText && matchesCancellationIntent(inboundText)) {
    await askToCancel(agendaAsk, inboundText);
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

  /**
   * R1 — ¿El cliente está CAMBIANDO una cita que ya tiene? Lo dice algún
   * mensaje suyo de esta sesión posterior a la última acción de agenda
   * completada, o la última pregunta del agente (una oferta "para cambiar tu
   * cita" o "¿confirmas que mueva tu cita…?"). Entonces elegir una hora es
   * reprogramar esa cita, no agendar otra, venga la hora de la selección
   * determinista o del `book_slot` del modelo.
   */
  const lastCompletedAgendaIndex = history.findLastIndex(
    (message) =>
      message.direction === "out" &&
      /^(?:¡Listo! (?:Te agendé|Reprogramé)|Listo, cancelé)/.test(message.text ?? "")
  );
  const rescheduleIntentTexts = [
    ...history
      .slice(lastCompletedAgendaIndex + 1)
      .filter((message) => message.direction === "in")
      .map((message) => message.text),
    lastOutboundBeforeInbound?.text,
  ];
  const reschedulingTexts = [inboundText, ...[...previousInboundTexts].reverse()];
  const activeBookingsIfRescheduling = async () =>
    rescheduleIntentTexts.some((text) => Boolean(text && matchesRescheduleIntent(text)))
      ? await listActiveBookingsForConversation({ organizationId, conversationId })
      : [];

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
        const picked = await pickOffer(
          organizationId,
          ofertas,
          resolution.offer.startUtc,
          lastInbound.text
        );
        if (picked.kind === "ambiguous") {
          await askProfessional(agendaAsk, picked.options, agendaContext.settings.timezone);
          return;
        }
        const chosen = picked.offer;
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
          /**
           * R1 — Elegir una hora mientras se habla de CAMBIAR una cita es
           * reprogramar, no agendar otra: la pendiente es `reschedule` sobre
           * la cita existente y al confirmar se mueve (no se crea una segunda).
           */
          const active = await activeBookingsIfRescheduling();
          if (active.length > 0) {
            await askToReschedule(agendaAsk, chosen, active, reschedulingTexts);
            return;
          }
          await askToBook(
            agendaAsk,
            chosen,
            selectedOfferConfirmationLabel(chosen.startUtc, agendaContext.settings.timezone)
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

  // Cancelar también se confirma: el modelo solo deja la acción pendiente y
  // pregunta; la ejecuta el bloque que consume la pendiente tras un "sí".
  if (action.action === "cancel_booking") {
    if (agenda) await askToCancel(agendaAsk, inboundText ?? "");
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
        } else {
          /**
           * IA-W1 / IA-W2 — El modelo NUNCA crea ni mueve una cita: elegir un
           * horario no es confirmarlo. Si la hora está en el catálogo vigente
           * queda la acción pendiente (con el servicio y el profesional de la
           * oferta) y se pregunta; la ejecuta el bloque que consume la
           * pendiente tras un "sí" explícito. Si no está, se vuelve a ofrecer.
           */
          const isBook = action.action === "book_slot";
          const picked = await pickOffer(organizationId, ofertas, action.startUtc, inboundText);
          if (picked.kind === "ambiguous") {
            await askProfessional(
              agendaAsk,
              picked.options,
              agendaContext?.settings.timezone ?? "America/Mexico_City"
            );
            return;
          }
          const chosen = picked.offer;
          if (chosen && isBook) {
            // R1 — también aquí: un `book_slot` en medio de un cambio de cita
            // deja una pendiente `reschedule` sobre la cita existente.
            const moving = await activeBookingsIfRescheduling();
            if (moving.length > 0) {
              await askToReschedule(agendaAsk, chosen, moving, reschedulingTexts);
              return;
            }
            await askToBook(agendaAsk, chosen, chosen.label);
            return;
          }
          if (chosen) {
            const active = await listActiveBookingsForConversation({
              organizationId,
              conversationId,
            });
            if (active.length === 0) {
              await clearPendingAction(organizationId, conversationId);
              await deliverReply(
                conversation,
                toneAwareFixedReply(
                  "No encontré una cita activa para reprogramar. Si quieres, puedo mostrarte horarios disponibles para una nueva cita.",
                  profile.tone
                )
              );
              return;
            }
            await askToReschedule(agendaAsk, chosen, active, reschedulingTexts);
            return;
          }
          await recordAgentAction({
            action: attemptedAction,
            success: false,
            status: "rejected",
            payload: { reason: "slot_not_offered", startUtc: action.startUtc },
          });
          observedAction = "offer_slots";
          turn = await offerSlots({
            organizationId,
            conversationId,
            intro: isBook
              ? "Ese horario no está entre las opciones disponibles. Estas son las opciones actuales:"
              : "Para cambiar tu cita, elige uno de estos horarios disponibles:",
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

/** Lo que necesita el agente para preguntar y dejar una pendiente. */
type AgendaAsk = { conversation: Conversation; tone: string | null };

type SlotChoice = {
  startUtc: string;
  serviceId?: string | null;
  professionalId?: string | null;
};

/** La pregunta "¿cuál de tus citas?" (tú y usted). */
const BOOKING_CHOICE_MARK = /citas activas a (?:tu|su) nombre:/;

function isBookingChoiceQuestion(text: string | null | undefined): boolean {
  return Boolean(text && BOOKING_CHOICE_MARK.test(text));
}

/**
 * Entrega la pregunta y deja la pendiente ligada a ESE mensaje: solo será
 * ejecutable mientras esta pregunta siga siendo el último mensaje saliente. Si
 * no se pudo entregar (ventana cerrada), no queda nada que confirmar.
 */
async function askAndHold(
  ctx: AgendaAsk,
  question: string,
  pending: Omit<
    Parameters<typeof setPendingAction>[0],
    "organizationId" | "conversationId" | "questionMessageId"
  >
): Promise<boolean> {
  const { organizationId, id: conversationId } = ctx.conversation;
  const questionMessageId = await deliverReply(
    ctx.conversation,
    toneAwareFixedReply(question, ctx.tone)
  );
  if (!questionMessageId) {
    await clearPendingAction(organizationId, conversationId);
    return false;
  }
  await setPendingAction({
    organizationId,
    conversationId,
    questionMessageId,
    ...pending,
  });
  return true;
}

async function slotLabel(organizationId: string, startUtc: string): Promise<string> {
  const { timezone } = await getSettings(organizationId);
  return selectedOfferConfirmationLabel(startUtc, timezone);
}

/**
 * Propone una reserva: queda pendiente `book` con el servicio y el profesional
 * elegidos. Si el cliente ya tiene una cita activa, lo dice y pregunta por OTRA
 * cita (la pregunta sigue siendo de sí o no); "muévela" la convierte en mover
 * la que ya tiene (ver `askToMoveInstead`).
 */
async function askToBook(ctx: AgendaAsk, chosen: OfferedSlot, label: string): Promise<void> {
  const active = await listActiveBookingsForConversation({
    organizationId: ctx.conversation.organizationId,
    conversationId: ctx.conversation.id,
  });
  const existing =
    active.length === 1 ? `una cita: ${active[0]!.label}.` : `${active.length} citas activas.`;
  const question =
    active.length === 0
      ? `Perfecto. Tengo ${label} disponible. ¿Quieres que agende tu cita?`
      : `Ya tienes ${existing} Tengo ${label} disponible. ¿Quieres que agende otra cita en ese horario? Si prefieres mover la que tienes, responde «muévela».`;
  const held = await askAndHold(
    ctx,
    question,
    {
      action: "book",
      startUtc: chosen.startUtc,
      serviceId: chosen.serviceId,
      professionalId: chosen.professionalId,
    }
  );
  if (held) {
    await recordAgentAction({
      action: "set_pending_book",
      payload: { startUtc: chosen.startUtc },
    });
  }
}

/** "muévela", "cámbiala", "sí, muévela": mover, sin nombrar otra hora. */
function wantsToMoveInstead(text: string): boolean {
  return matchesRescheduleIntent(text) && !/\d/.test(text);
}

/**
 * Ante una reserva pendiente (la pregunta que avisa que ya tiene una cita),
 * "muévela" pide mover la cita que ya tiene a ESA hora: se pregunta de nuevo,
 * nombrando la hora vieja y la nueva. Devuelve false si no aplica.
 */
async function askToMoveInstead(
  ctx: AgendaAsk,
  pending: PendingAgendaAction,
  text: string
): Promise<boolean> {
  if (pending.action !== "book" || !pending.startUtc || !wantsToMoveInstead(text)) return false;
  const active = await listActiveBookingsForConversation({
    organizationId: ctx.conversation.organizationId,
    conversationId: ctx.conversation.id,
  });
  if (active.length === 0) return false;
  await askToReschedule(
    ctx,
    {
      startUtc: pending.startUtc,
      serviceId: pending.serviceId,
      professionalId: pending.professionalId,
    },
    active,
    [text]
  );
  return true;
}

/**
 * Pide confirmar la cancelación nombrando la cita. Con varias citas activas
 * y un mensaje que no dice cuál, las lista y pregunta: la pendiente queda sin
 * cita (nunca ejecutable) hasta que el cliente elija.
 */
async function askToCancel(ctx: AgendaAsk, text: string): Promise<void> {
  const { organizationId, id: conversationId } = ctx.conversation;
  const active = await listActiveBookingsForConversation({ organizationId, conversationId });
  if (active.length === 0) {
    await clearPendingAction(organizationId, conversationId);
    await deliverReply(
      ctx.conversation,
      toneAwareFixedReply("No encontré una cita activa para cancelar.", ctx.tone)
    );
    return;
  }
  const target = active.length === 1 ? active[0]! : resolveBookingReference(text, active);
  if (target) {
    await confirmCancellation(ctx, target);
    return;
  }
  const held = await askAndHold(
    ctx,
    `Veo ${active.length} citas activas a tu nombre:\n${bookingChoiceList(active)}\n¿Cuál quieres cancelar? Responde con el número o la fecha.`,
    { action: "cancel" }
  );
  if (held) {
    await recordAgentAction({
      action: "set_pending_cancel",
      payload: { awaitingChoice: true, bookings: active.length },
    });
  }
}

async function confirmCancellation(ctx: AgendaAsk, target: ActiveBookingRef): Promise<void> {
  const held = await askAndHold(
    ctx,
    `Antes de cancelar necesito tu confirmación: ¿confirmas que quieres cancelar tu cita: ${target.label}? Responde «sí» y la cancelo.`,
    { action: "cancel", bookingId: target.id }
  );
  if (held) {
    await recordAgentAction({
      action: "set_pending_cancel",
      entityType: "booking",
      entityId: target.id,
    });
  }
}

/**
 * Pide confirmar que se mueva UNA cita a la hora elegida, nombrando la hora
 * vieja y la nueva. Con varias citas, la elige por lo que dijo el cliente
 * (este mensaje o los anteriores); si no se distingue, las lista y pregunta.
 */
async function askToReschedule(
  ctx: AgendaAsk,
  slot: SlotChoice,
  active: ActiveBookingRef[],
  texts: (string | null | undefined)[]
): Promise<void> {
  const target =
    active.length === 1
      ? active[0]!
      : texts
          .map((text) => (text ? resolveBookingReference(text, active) : null))
          .find((found): found is ActiveBookingRef => found !== null) ?? null;
  if (target) {
    await confirmReschedule(ctx, target, slot);
    return;
  }
  const newLabel = await slotLabel(ctx.conversation.organizationId, slot.startUtc);
  const held = await askAndHold(
    ctx,
    `Veo ${active.length} citas activas a tu nombre:\n${bookingChoiceList(active)}\n¿Cuál quieres mover a ${newLabel}? Responde con el número o la fecha.`,
    {
      action: "reschedule",
      startUtc: slot.startUtc,
      serviceId: slot.serviceId,
      professionalId: slot.professionalId,
    }
  );
  if (held) {
    await recordAgentAction({
      action: "set_pending_reschedule",
      payload: { awaitingChoice: true, startUtc: slot.startUtc },
    });
  }
}

async function confirmReschedule(
  ctx: AgendaAsk,
  target: ActiveBookingRef,
  slot: SlotChoice
): Promise<void> {
  const newLabel = await slotLabel(ctx.conversation.organizationId, slot.startUtc);
  const held = await askAndHold(
    ctx,
    `Tu cita actual: ${target.label}. Tengo ${newLabel}. ¿Confirmas que mueva tu cita a ese horario?`,
    {
      action: "reschedule",
      bookingId: target.id,
      startUtc: slot.startUtc,
      serviceId: slot.serviceId,
      professionalId: slot.professionalId,
    }
  );
  if (held) {
    await recordAgentAction({
      action: "set_pending_reschedule",
      entityType: "booking",
      entityId: target.id,
      payload: { startUtc: slot.startUtc },
    });
  }
}

type OfferPick =
  | { kind: "one"; offer: OfferedSlot | null }
  | { kind: "ambiguous"; options: { offer: OfferedSlot; name: string }[] };

function normalizeName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * La oferta de ese instante. Si a la misma hora hay ofertas con distinto
 * profesional, se elige la del profesional que el cliente nombró; si no nombró
 * a ninguno, es ambigua y se le pregunta (nunca se toma la primera).
 */
async function pickOffer(
  organizationId: string,
  offers: OfferedSlot[],
  startUtc: string,
  text: string | null
): Promise<OfferPick> {
  const instant = Date.parse(startUtc);
  const same = offers.filter((offer) => Date.parse(offer.startUtc) === instant);
  const professionalIds = [
    ...new Set(same.map((offer) => offer.professionalId).filter((id): id is string => Boolean(id))),
  ];
  if (professionalIds.length <= 1) {
    return { kind: "one", offer: findOffered(offers, startUtc) };
  }
  const rows = await getDb()
    .select({ id: schema.professional.id, name: schema.professional.name })
    .from(schema.professional)
    .where(
      scoped(
        schema.professional.organizationId,
        organizationId,
        inArray(schema.professional.id, professionalIds)
      )
    );
  const options = same.flatMap((offer) => {
    const row = rows.find((candidate) => candidate.id === offer.professionalId);
    return row ? [{ offer, name: row.name }] : [];
  });
  const said = normalizeName(text ?? "");
  const mentioned = options.filter((option) => {
    const name = normalizeName(option.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9ñ])${name}(?:$|[^a-z0-9ñ])`).test(said);
  });
  if (mentioned.length === 1) return { kind: "one", offer: mentioned[0]!.offer };
  return { kind: "ambiguous", options };
}

/** Dos profesionales a la misma hora: se pregunta con quién, sin dejar pendiente. */
async function askProfessional(
  ctx: AgendaAsk,
  options: { offer: OfferedSlot; name: string }[],
  timezone: string
): Promise<void> {
  const when = selectedOfferConfirmationLabel(options[0]!.offer.startUtc, timezone);
  await clearPendingAction(ctx.conversation.organizationId, ctx.conversation.id);
  await deliverReply(
    ctx.conversation,
    toneAwareFixedReply(
      `Tengo ${when} con:\n${options.map((option) => `• ${option.name}`).join("\n")}\n¿Con quién prefieres?`,
      ctx.tone
    )
  );
}

/** Cancela ESA cita (la de la pendiente): si ya no está activa, no toca otra. */
async function handleCancellation(
  conversation: Conversation,
  bookingId: string,
  tone: string | null
): Promise<void> {
  let executed = false;
  try {
    const cancelled = await cancelBookingForConversation({
      organizationId: conversation.organizationId,
      conversationId: conversation.id,
      bookingId,
    });
    executed = true;
    await recordAgentAction({
      action: "cancel_booking",
      entityType: "booking",
      entityId: cancelled.bookingId,
    });
    await deliverAgendaReply(
      conversation,
      toneAwareFixedReply(`Listo, cancelé tu cita: ${cancelled.label}.`, tone)
    );
  } catch (err) {
    if (!executed && err instanceof BookingError && err.code === "not_found") {
      await bestEffort("registro de cancelación rechazada", () =>
        recordAgentAction({
          action: "cancel_booking",
          success: false,
          status: "rejected",
          entityType: "booking",
          entityId: bookingId,
          payload: { reason: err.code },
        })
      );
      await deliverAgendaReply(
        conversation,
        toneAwareFixedReply("No encontré una cita activa para cancelar.", tone)
      );
      return;
    }
    await failPendingAction(conversation, "cancel", err, tone, executed, bookingId);
  }
}

/** Texto determinista cuando ejecutar una pendiente falla de forma inesperada. */
const PENDING_FAILURE_REPLY: Record<"book" | "reschedule" | "cancel", string> = {
  book: "No pude agendar tu cita automáticamente. Un asesor continuará contigo.",
  reschedule: "No pude mover tu cita automáticamente. Un asesor continuará contigo.",
  cancel: "No pude cancelar tu cita automáticamente. Un asesor continuará contigo.",
};

const PENDING_ACTION_NAME = {
  book: "book_slot",
  reschedule: "reschedule_slot",
  cancel: "cancel_booking",
} as const;

/**
 * Un error inesperado al ejecutar una pendiente ya consumida: se registra, se
 * pasa la conversación a un asesor y se le avisa al cliente con un texto fijo.
 * Si la acción SÍ se ejecutó y lo que falló fue después (registrar o enviar la
 * confirmación), no se dice que falló: queda el handoff para que un asesor
 * confirme. Nunca relanza: el reintento del job haría improvisar al modelo.
 */
async function failPendingAction(
  conversation: Conversation,
  action: "book" | "reschedule" | "cancel",
  err: unknown,
  tone: string | null,
  executed: boolean,
  bookingId?: string
): Promise<void> {
  console.error(
    `[agente] ejecutar la acción de agenda ${action} falló${executed ? " después de ejecutarla" : ""}: ${String(err).slice(0, 500)}`
  );
  await bestEffort("registro del fallo de agenda", () =>
    recordAgentAction({
      action: PENDING_ACTION_NAME[action],
      success: false,
      status: "failed",
      ...(bookingId ? { entityType: "booking", entityId: bookingId } : {}),
      payload: { error: String(err), executed },
    })
  );
  const claimed = await bestEffort("handoff tras fallo de agenda", () =>
    applyHandoff(conversation.id, conversation.organizationId, "error")
  );
  if (claimed && !executed) {
    await deliverAgendaReply(
      conversation,
      toneAwareFixedReply(PENDING_FAILURE_REPLY[action], tone)
    );
  }
}

/**
 * B-2 — Mover una cita a un horario que ya no sirve (`slot_not_offered`) o que
 * se acaba de ocupar (`slot_taken`): se ofrecen alternativas; al elegir otra,
 * la selección vuelve a preguntar antes de mover.
 */
async function reofferReschedule(
  conversation: Conversation,
  code: "slot_not_offered" | "slot_taken",
  tone: string | null
): Promise<void> {
  const { organizationId, id: conversationId } = conversation;
  try {
    await recordAgentAction({
      action: "reschedule_slot",
      success: false,
      status: "rejected",
      payload: { reason: code },
    });
    const turn = await offerSlots({
      organizationId,
      conversationId,
      intro:
        code === "slot_taken"
          ? "Ese horario ya no está disponible para mover tu cita. Elige otro:"
          : "Ese horario ya no sirve para mover tu cita. Elige otro:",
    });
    await recordOfferedSlots(organizationId, conversationId, turn);
    await deliverAgendaReply(conversation, toneAwareFixedReply(turn.text, tone));
  } catch (err) {
    await failPendingAction(conversation, "reschedule", err, tone, false);
  }
}

/**
 * Envía una respuesta de agenda sin dejar que un fallo del envío vuelva al
 * job: si no se pudo enviar, la conversación pasa a un asesor.
 */
async function deliverAgendaReply(
  conversation: Conversation,
  text: string
): Promise<string | null> {
  try {
    return await deliverReply(conversation, text);
  } catch (err) {
    console.error(`[agente] no se pudo enviar la respuesta de agenda: ${String(err).slice(0, 500)}`);
    await bestEffort("handoff tras fallo de envío", () =>
      applyHandoff(conversation.id, conversation.organizationId, "error")
    );
    return null;
  }
}

/** Ejecuta un paso secundario (registro, handoff) sin relanzar su error. */
async function bestEffort<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[agente] ${what} falló: ${String(err).slice(0, 300)}`);
    return null;
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
