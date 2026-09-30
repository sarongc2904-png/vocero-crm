import {
  END,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { chatJson } from "@/lib/ai";
import {
  agentActionSchema,
  degradeAction,
  resolveStage,
  type AgentActionType,
} from "@/server/ai/actions";
import { enforceAgentCapabilities } from "@/server/ai/capability-guard";
import { matchesHandoffIntent } from "@/server/ai/handoff";
import { buildAgentSystemPrompt } from "@/server/ai/prompts";
import { matchesCancellationIntent } from "@/server/agenda/cancel-intent";
import { findSlot } from "@/server/agenda/availability";
import { findOffered } from "@/server/agenda/offers";
import { findProfessionalSlot } from "@/server/agenda/professional-availability";
import { hasSchedulingSignal } from "@/server/agenda/schedule-request";
import {
  factualHoursReply,
  resolveScheduleIntent,
} from "@/server/agenda/schedule-intent";
import {
  hasBookingConfirmation,
  isAffirmativeConfirmation,
  isBareTimeSelection,
  resolveOfferedTimeSelection,
  selectedOfferConfirmationLabel,
} from "@/server/agenda/selection";
import { DEFAULT_TIMEZONE } from "@/server/agenda/settings";
import {
  loadShadowContext,
  type LoadedShadowContext,
  type ShadowContextInput,
} from "@/server/ai/graph/context";
import {
  ShadowAgentState,
  type ShadowAgentGraphState,
  type ShadowAgentGraphUpdate,
  type ShadowDecision,
  type ShadowIntent,
} from "@/server/ai/graph/state";

const COMMERCIAL_SIGNAL =
  /\b(?:precio|costo|cuesta|comprar|contratar|servicio|producto|plan|paquete|cotiz|informaci[oó]n)\b/i;

export type ShadowAgentInput = {
  conversationId: string;
  expectedOrganizationId: string;
  expectedInboundMessageId: string;
};

export type ShadowGraphDependencies = {
  now: () => Date;
  loadContext: (input: ShadowContextInput) => Promise<LoadedShadowContext>;
  proposeAction: (
    state: ShadowAgentGraphState,
    intent: "commercial" | "general"
  ) => Promise<unknown>;
  findSlot: typeof findSlot;
  findProfessionalSlot: typeof findProfessionalSlot;
};

export type ShadowGraphOptions = {
  dependencies?: Partial<ShadowGraphDependencies>;
  /** Preparado para persistencia futura; por defecto no hay checkpoints. */
  checkpointer?: BaseCheckpointSaver | false;
};

const defaultDependencies: ShadowGraphDependencies = {
  now: () => new Date(),
  loadContext: loadShadowContext,
  proposeAction: proposeModelAction,
  findSlot,
  findProfessionalSlot,
};

function blocked(
  node: string,
  reason: string,
  error: string | null = null
): ShadowAgentGraphUpdate {
  return {
    stop: true,
    error,
    blockedReason: reason,
    validatedAction: { action: "none" },
    trace: [node],
  };
}

async function proposeModelAction(
  state: ShadowAgentGraphState
): Promise<unknown> {
  const context = state.context;
  if (!context?.profile) throw new Error("agent_profile_missing");

  const system = buildAgentSystemPrompt({
    profile: context.profile,
    kb: context.kb,
    stages: context.stages,
    agenda: state.agendaEnabled,
  });
  const result = await chatJson(agentActionSchema(state.agendaEnabled), [
    { role: "system", content: system },
    ...context.history,
  ]);
  if (!result.ok) throw new Error(`model_${result.error}`);
  return result.data;
}

function agendaIntent(state: ShadowAgentGraphState): boolean {
  const context = state.context;
  const timezone = context?.settings?.timezone ?? DEFAULT_TIMEZONE;
  return (
    isBareTimeSelection(state.inboundText) ||
    hasBookingConfirmation(state.inboundText) ||
    hasSchedulingSignal({
      text: state.inboundText,
      now: context?.now ?? new Date(0),
      timezone,
    })
  );
}

function sanitizeActionTexts(
  action: AgentActionType,
  agenda: boolean
): AgentActionType {
  const safe = (text: string) => enforceAgentCapabilities({ text, agenda });
  switch (action.action) {
    case "reply":
      return { ...action, text: safe(action.text) };
    case "update_lead":
    case "move_stage":
      return action.reply ? { ...action, reply: safe(action.reply) } : action;
    case "handoff":
      return action.farewell
        ? { ...action, farewell: safe(action.farewell) }
        : action;
    case "offer_slots":
    case "book_slot":
    case "reschedule_slot":
      return action.reply ? { ...action, reply: safe(action.reply) } : action;
    default:
      return action;
  }
}

function routeIntent(state: ShadowAgentGraphState): ShadowIntent {
  if (matchesHandoffIntent(state.inboundText)) return "handoff";
  if (matchesCancellationIntent(state.inboundText)) return "cancel";
  if (agendaIntent(state)) return "scheduling";
  return COMMERCIAL_SIGNAL.test(state.inboundText) ? "commercial" : "general";
}

function actionName(action: AgentActionType | null): string | null {
  return action?.action === "none" || !action ? null : action.action;
}

function executionFor(state: ShadowAgentGraphState): string | null {
  const action = state.validatedAction;
  if (!action || action.action === "none") return null;
  if (action.action === "cancel_booking") {
    return state.pendingActionConfirmed ? "cancel_booking" : "set_pending_cancel";
  }
  if (action.action === "book_slot") {
    return state.pendingActionConfirmed ? "book_slot" : "set_pending_book";
  }
  if (action.action === "reschedule_slot") {
    return state.pendingActionConfirmed
      ? "reschedule_slot"
      : "set_pending_reschedule";
  }
  return actionName(action);
}

function replyFor(state: ShadowAgentGraphState): string | null {
  if (state.reply) return state.reply;
  const action = state.validatedAction;
  if (!action) return null;
  if (action.action === "reply") return action.text;
  if (action.action === "handoff") return action.farewell ?? null;
  if (action.action === "update_lead" || action.action === "move_stage") {
    return action.reply ?? null;
  }
  if (
    action.action === "offer_slots" ||
    action.action === "book_slot" ||
    action.action === "reschedule_slot"
  ) {
    return action.reply ?? null;
  }
  return null;
}

export function createShadowAgentGraph(options: ShadowGraphOptions = {}) {
  const dependencies = { ...defaultDependencies, ...options.dependencies };

  const graph = new StateGraph(ShadowAgentState)
    .addNode("load_context", async (state) => {
      try {
        const loaded = await dependencies.loadContext({
          conversationId: state.conversationId,
          expectedOrganizationId: state.expectedOrganizationId,
          now: dependencies.now(),
        });
        const context = loaded.context;
        if (!context) return blocked("load_context", "conversation_not_found");
        const loadedState = {
          context,
          inboundText: context.lastInboundText ?? "",
          organizationId: context.conversation.organizationId,
          isTest: context.conversation.isTest,
          aiEnabled: context.conversation.aiEnabled,
          commercialAccess: loaded.commercialAccess,
          agendaEnabled: loaded.agendaEnabled,
          hasHandoff: Boolean(context.conversation.handoffAt),
          agentProfileFound: Boolean(context.profile),
          agentProfileEnabled: Boolean(context.profile?.enabled),
          whatsappWindowOpen: loaded.whatsappWindowOpen,
          trace: ["load_context"],
        } satisfies ShadowAgentGraphUpdate;
        if (!context.lastInboundMessageId) {
          return {
            ...loadedState,
            ...blocked("load_context", "inbound_not_found"),
          };
        }
        if (context.lastInboundMessageId !== state.expectedInboundMessageId) {
          return {
            ...loadedState,
            ...blocked("load_context", "inbound_mismatch"),
          };
        }
        return loadedState;
      } catch (error) {
        return blocked(
          "load_context",
          "context_load_failed",
          error instanceof Error ? error.message : String(error)
        );
      }
    })
    .addNode("commercial_guard", (state) => {
      if (
        state.organizationId !== state.expectedOrganizationId
      ) {
        return blocked("commercial_guard", "tenant_mismatch");
      }
      if (!state.isTest && !state.commercialAccess) {
        return blocked("commercial_guard", "commercial_access_denied");
      }
      return { trace: ["commercial_guard"] };
    })
    .addNode("conversation_guard", (state) => {
      if (!state.aiEnabled) return blocked("conversation_guard", "ai_disabled");
      if (state.hasHandoff) {
        return blocked("conversation_guard", "handoff_already_active");
      }
      if (!state.agentProfileFound) {
        return blocked("conversation_guard", "agent_profile_missing");
      }
      if (!state.isTest && !state.agentProfileEnabled) {
        return blocked("conversation_guard", "agent_profile_disabled");
      }
      if (!state.isTest && !state.whatsappWindowOpen) {
        return blocked("conversation_guard", "whatsapp_window_closed");
      }
      return { trace: ["conversation_guard"] };
    })
    .addNode("pending_action_router", (state) => {
      const pending = state.context?.pendingAction;
      if (!pending || !isAffirmativeConfirmation(state.inboundText)) {
        return { trace: ["pending_action_router"] };
      }
      if (pending.action === "cancel") {
        return {
          intent: "cancel" as const,
          proposedAction: { action: "cancel_booking" },
          pendingActionConfirmed: true,
          actionSource: "pending" as const,
          trace: ["pending_action_router"],
        };
      }
      if (!pending.startUtc) {
        return blocked("pending_action_router", "pending_action_invalid");
      }
      return {
        intent: "scheduling" as const,
        proposedAction: {
          action: pending.action === "book" ? "book_slot" : "reschedule_slot",
          startUtc: pending.startUtc,
        },
        pendingActionConfirmed: true,
        actionSource: "pending" as const,
        authorizedSlot: {
          startUtc: pending.startUtc,
          serviceId: pending.serviceId,
          professionalId: pending.professionalId,
          bookingId:
            pending.action === "reschedule" ? pending.bookingId : null,
        },
        trace: ["pending_action_router"],
      };
    })
    .addNode("intent_router", (state) => ({
      intent: routeIntent(state),
      trace: ["intent_router"],
    }))
    .addNode("handoff_decision", () => ({
      proposedAction: {
        action: "handoff",
        reason: "cliente",
        farewell:
          "Claro. Voy a pasar tu conversación a un asesor. La IA quedaría en pausa mientras te atienden.",
      },
      actionSource: "deterministic" as const,
      trace: ["handoff_decision"],
    }))
    .addNode("cancel_decision", () => ({
      proposedAction: { action: "cancel_booking" },
      actionSource: "deterministic" as const,
      reply:
        "Antes de cancelar necesitaría tu confirmación. Responde «sí» para continuar.",
      trace: ["cancel_decision"],
    }))
    .addNode("scheduling_decision", (state) => {
      const context = state.context;
      const settings = context?.settings;
      if (
        settings &&
        context.lastOutboundText &&
        context.lastOutboundAt &&
        isBareTimeSelection(state.inboundText)
      ) {
        const resolution = resolveOfferedTimeSelection({
          text: state.inboundText,
          offers: context.offers,
          lastOutboundText: context.lastOutboundText,
          timezone: settings.timezone,
          shownAt: context.lastOutboundAt,
        });
        if (resolution.kind === "match") {
          return {
            proposedAction: {
              action: "book_slot",
              startUtc: resolution.offer.startUtc,
            },
            reply: `Perfecto. Tengo ${selectedOfferConfirmationLabel(
              resolution.offer.startUtc,
              settings.timezone
            )} disponible. ¿Quieres que agende tu cita?`,
            actionSource: "deterministic" as const,
            authorizedSlot: {
              startUtc: resolution.offer.startUtc,
              serviceId: resolution.offer.serviceId ?? null,
              professionalId: resolution.offer.professionalId ?? null,
              bookingId: null,
            },
            trace: ["scheduling_decision"],
          };
        }
        if (resolution.kind === "ambiguous") {
          const choices = resolution.offers
            .map((offer) =>
              selectedOfferConfirmationLabel(offer.startUtc, settings.timezone)
            )
            .join("; ");
          return {
            proposedAction: {
              action: "reply",
              text: `Encontré más de una opción: ${choices}. ¿Cuál quieres elegir?`,
            },
            actionSource: "deterministic" as const,
            trace: ["scheduling_decision"],
          };
        }
        if (resolution.kind === "not_found") {
          return {
            proposedAction: {
              action: "offer_slots",
              reply:
                "No encontré esa hora entre las opciones mostradas. Consultaría opciones actuales.",
            },
            actionSource: "deterministic" as const,
            trace: ["scheduling_decision"],
          };
        }
      }

      if (settings) {
        const scheduleIntent = resolveScheduleIntent({
          text: state.inboundText,
          now: context.now,
          weeklyHours: settings.weeklyHours,
          timezone: settings.timezone,
        });
        if (
          scheduleIntent.kind === "date_mentioned" &&
          !scheduleIntent.requiresAvailabilityLookup
        ) {
          return {
            proposedAction: {
              action: "reply",
              text: factualHoursReply(scheduleIntent),
            },
            actionSource: "deterministic" as const,
            trace: ["scheduling_decision"],
          };
        }
      }

      return {
        proposedAction: { action: "offer_slots" },
        actionSource: "deterministic" as const,
        trace: ["scheduling_decision"],
      };
    })
    .addNode("commercial_decision", async (state) => {
      try {
        return {
          proposedAction: await dependencies.proposeAction(state, "commercial"),
          actionSource: "model" as const,
          trace: ["commercial_decision"],
        };
      } catch (error) {
        return blocked(
          "commercial_decision",
          "decision_failed",
          error instanceof Error ? error.message : String(error)
        );
      }
    })
    .addNode("general_decision", async (state) => {
      try {
        return {
          proposedAction: await dependencies.proposeAction(state, "general"),
          actionSource: "model" as const,
          trace: ["general_decision"],
        };
      } catch (error) {
        return blocked(
          "general_decision",
          "decision_failed",
          error instanceof Error ? error.message : String(error)
        );
      }
    })
    .addNode("validate_action", (state) => {
      // Primero reconoce el contrato completo; el siguiente nodo aplica las
      // capacidades reales del tenant y degrada agenda cuando está apagada.
      const parsed = agentActionSchema(true).safeParse(state.proposedAction);
      if (!parsed.success) return blocked("validate_action", "action_invalid");
      const action = parsed.data as AgentActionType;
      if (
        state.actionSource === "model" &&
        (action.action === "book_slot" || action.action === "reschedule_slot")
      ) {
        const offer = findOffered(state.context?.offers ?? [], action.startUtc);
        if (!offer) return blocked("validate_action", "slot_not_offered");
        return {
          validatedAction: action,
          authorizedSlot: {
            startUtc: offer.startUtc,
            serviceId: offer.serviceId ?? null,
            professionalId: offer.professionalId ?? null,
            bookingId: null,
          },
          trace: ["validate_action"],
        };
      }
      return {
        validatedAction: action,
        trace: ["validate_action"],
      };
    })
    .addNode("revalidate_slot", async (state) => {
      const action = state.validatedAction;
      if (
        !action ||
        (action.action !== "book_slot" && action.action !== "reschedule_slot")
      ) {
        return { trace: ["revalidate_slot"] };
      }
      const slot = state.authorizedSlot;
      const organizationId = state.organizationId;
      const context = state.context;
      if (!slot || !organizationId || !context) {
        return blocked("revalidate_slot", "slot_context_invalid");
      }
      const hasService = Boolean(slot.serviceId);
      const hasProfessional = Boolean(slot.professionalId);
      if (hasService !== hasProfessional) {
        return blocked("revalidate_slot", "slot_context_invalid");
      }
      try {
        const excludeBookingId =
          action.action === "reschedule_slot" && slot.bookingId
            ? slot.bookingId
            : undefined;
        const available =
          hasService && hasProfessional
            ? await dependencies.findProfessionalSlot(organizationId, {
                serviceId: slot.serviceId!,
                professionalId: slot.professionalId!,
                startUtc: slot.startUtc,
                excludeBookingId,
                now: context.now,
              })
            : context.settings
              ? await dependencies.findSlot(organizationId, slot.startUtc, {
                  excludeBookingId,
                  now: context.now,
                  settings: context.settings,
                })
              : null;
        if (!available) return blocked("revalidate_slot", "slot_unavailable");
        return { trace: ["revalidate_slot"] };
      } catch (error) {
        return blocked(
          "revalidate_slot",
          "availability_check_failed",
          error instanceof Error ? error.message : String(error)
        );
      }
    })
    .addNode("capability_guard", (state) => {
      const action = state.validatedAction;
      if (!action) return blocked("capability_guard", "action_missing");
      if (
        !state.agendaEnabled &&
        (action.action === "offer_slots" ||
          action.action === "book_slot" ||
          action.action === "reschedule_slot" ||
          action.action === "cancel_booking")
      ) {
        return {
          ...blocked("capability_guard", "agenda_disabled"),
          validatedAction: sanitizeActionTexts(degradeAction(action), false),
        };
      }
      if (action.action === "move_stage") {
        const stage = resolveStage(action.stage, state.context?.stages ?? []);
        if (!stage) {
          return {
            ...blocked("capability_guard", "invalid_stage"),
            validatedAction: sanitizeActionTexts(
              degradeAction(action),
              state.agendaEnabled
            ),
          };
        }
      }
      return {
        validatedAction: sanitizeActionTexts(action, state.agendaEnabled),
        reply: state.reply
          ? enforceAgentCapabilities({
              text: state.reply,
              agenda: state.agendaEnabled,
            })
          : state.reply,
        trace: ["capability_guard"],
      };
    })
    .addNode("shadow_result", (state) => {
      const trace = [...state.trace, "shadow_result"];
      const decision: ShadowDecision = {
        conversationId: state.conversationId,
        organizationId: state.organizationId,
        intent: state.intent,
        proposedAction: state.proposedAction,
        validatedAction: state.validatedAction,
        wouldExecute: state.stop ? null : executionFor(state),
        wouldReply: state.stop ? null : replyFor(state),
        blocked: state.stop || Boolean(state.blockedReason || state.error),
        reason: state.blockedReason ?? state.error,
        trace,
      };
      return { shadowDecision: decision, trace: ["shadow_result"] };
    });

  graph.addEdge(START, "load_context");
  graph.addConditionalEdges("load_context", (state) =>
    state.stop ? "shadow_result" : "commercial_guard"
  );
  graph.addConditionalEdges("commercial_guard", (state) =>
    state.stop ? "shadow_result" : "conversation_guard"
  );
  graph.addConditionalEdges("conversation_guard", (state) =>
    state.stop ? "shadow_result" : "pending_action_router"
  );
  graph.addConditionalEdges("pending_action_router", (state) => {
    if (state.stop) return "shadow_result";
    return state.pendingActionConfirmed ? "validate_action" : "intent_router";
  });
  graph.addConditionalEdges("intent_router", (state) => {
    switch (state.intent) {
      case "handoff":
        return "handoff_decision";
      case "cancel":
        return "cancel_decision";
      case "scheduling":
        return "scheduling_decision";
      case "commercial":
        return "commercial_decision";
      default:
        return "general_decision";
    }
  });
  graph.addEdge("handoff_decision", "validate_action");
  graph.addEdge("cancel_decision", "validate_action");
  graph.addEdge("scheduling_decision", "validate_action");
  graph.addConditionalEdges("commercial_decision", (state) =>
    state.stop ? "shadow_result" : "validate_action"
  );
  graph.addConditionalEdges("general_decision", (state) =>
    state.stop ? "shadow_result" : "validate_action"
  );
  graph.addConditionalEdges("validate_action", (state) => {
    if (state.stop) return "shadow_result";
    return state.validatedAction?.action === "book_slot" ||
      state.validatedAction?.action === "reschedule_slot"
      ? "revalidate_slot"
      : "capability_guard";
  });
  graph.addConditionalEdges("revalidate_slot", (state) =>
    state.stop ? "shadow_result" : "capability_guard"
  );
  graph.addEdge("capability_guard", "shadow_result");
  graph.addEdge("shadow_result", END);

  return graph.compile({ checkpointer: options.checkpointer });
}

export async function runShadowAgent(
  input: ShadowAgentInput,
  options: ShadowGraphOptions = {}
): Promise<ShadowDecision> {
  const result = await createShadowAgentGraph(options).invoke({
    conversationId: input.conversationId,
    expectedOrganizationId: input.expectedOrganizationId,
    expectedInboundMessageId: input.expectedInboundMessageId,
    organizationId: null,
    // load_context lo reemplaza con el último inbound persistido.
    inboundText: "",
    isTest: false,
    aiEnabled: false,
    commercialAccess: false,
    agendaEnabled: false,
    hasHandoff: false,
    agentProfileFound: false,
    agentProfileEnabled: false,
    whatsappWindowOpen: false,
    intent: null,
    proposedAction: null,
    validatedAction: null,
    reply: null,
    stop: false,
    error: null,
    blockedReason: null,
    shadowDecision: null,
    context: null,
    pendingActionConfirmed: false,
    actionSource: null,
    authorizedSlot: null,
    trace: [],
  });
  if (!result.shadowDecision) {
    throw new Error("shadow_result_missing");
  }
  return result.shadowDecision;
}
