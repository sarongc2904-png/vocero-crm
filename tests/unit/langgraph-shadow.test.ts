import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CALENDAR_SETTINGS } from "@/server/agenda/settings";
import {
  runShadowAgent,
  type ShadowGraphDependencies,
} from "@/server/ai/graph/graph";
import type { ShadowContext } from "@/server/ai/graph/state";

const NOW = new Date("2026-09-30T18:00:00.000Z");

function context(
  overrides: Partial<ShadowContext> = {},
  organizationId = "org_a"
): ShadowContext {
  return {
    now: NOW,
    conversation: {
      id: "conv_1",
      organizationId,
      contactId: "contact_1",
      isTest: false,
      aiEnabled: true,
      handoffAt: null,
      lastInboundAt: new Date("2026-09-30T17:55:00.000Z"),
    },
    profile: {
      id: "profile_1",
      organizationId,
      enabled: true,
      name: "Asistente",
      tone: null,
      instructions: null,
      escalationRules: null,
      greeting: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    history: [{ role: "user", content: "Hola" }],
    lastInboundText: "Hola",
    lastOutboundText: null,
    lastOutboundAt: null,
    kb: [],
    stages: [{ id: "stage_1", name: "Nuevo" }],
    settings: DEFAULT_CALENDAR_SETTINGS,
    offers: [],
    pendingAction: null,
    ...overrides,
  };
}

function dependencies(input?: {
  context?: ShadowContext | null;
  commercialAccess?: boolean;
  agendaEnabled?: boolean;
  whatsappWindowOpen?: boolean;
  proposedAction?: unknown;
}): ShadowGraphDependencies {
  return {
    now: () => NOW,
    loadContext: vi.fn(async () => ({
      context: input?.context === undefined ? context() : input.context,
      commercialAccess: input?.commercialAccess ?? true,
      agendaEnabled: input?.agendaEnabled ?? true,
      whatsappWindowOpen: input?.whatsappWindowOpen ?? true,
    })),
    proposeAction: vi.fn(async () =>
      input?.proposedAction === undefined
        ? { action: "reply", text: "Respuesta segura" }
        : input.proposedAction
    ),
  };
}

async function run(
  inboundText: string,
  deps: ShadowGraphDependencies,
  expectedOrganizationId = "org_a"
) {
  const loadContext = deps.loadContext;
  return runShadowAgent(
    { conversationId: "conv_1", expectedOrganizationId },
    {
      dependencies: {
        ...deps,
        loadContext: async (input) => {
          const loaded = await loadContext(input);
          return loaded.context
            ? {
                ...loaded,
                context: {
                  ...loaded.context,
                  lastInboundText: inboundText,
                  history: [{ role: "user", content: inboundText }],
                },
              }
            : loaded;
        },
      },
    }
  );
}

describe("LangGraph shadow runtime", () => {
  it("permanece desconectado de mutaciones y entregas productivas", () => {
    const graph = readFileSync(
      resolve(process.cwd(), "src/server/ai/graph/graph.ts"),
      "utf8"
    );

    expect(graph).not.toContain("runAgentTurn");
    expect(graph).not.toContain("sendText");
    expect(graph).not.toContain("bookSlot");
    expect(graph).not.toContain("rescheduleSlot");
    expect(graph).not.toContain("cancelBooking");
    expect(graph).not.toContain("setPendingAction");
    expect(graph).not.toContain("applyHandoff");
  });

  it("bloquea una conversación inexistente", async () => {
    const result = await run("Hola", dependencies({ context: null }));

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("conversation_not_found");
    expect(result.trace).toEqual(["load_context", "shadow_result"]);
  });

  it("bloquea tenant mismatch", async () => {
    const result = await run("Hola", dependencies({ context: context({}, "org_b") }));

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("tenant_mismatch");
    expect(result.organizationId).toBe("org_b");
  });

  it("bloquea una organización sin entitlement", async () => {
    const result = await run("Hola", dependencies({ commercialAccess: false }));

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("commercial_access_denied");
  });

  it("termina temprano cuando ya existe handoff", async () => {
    const snapshot = context({
      conversation: {
        ...context().conversation,
        handoffAt: NOW,
      },
    });
    const result = await run("Hola", dependencies({ context: snapshot }));

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("handoff_already_active");
  });

  it("termina temprano cuando la IA está desactivada", async () => {
    const snapshot = context({
      conversation: { ...context().conversation, aiEnabled: false },
    });
    const result = await run("Hola", dependencies({ context: snapshot }));

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("ai_disabled");
  });

  it("bloquea si no existe perfil", async () => {
    const result = await run(
      "Hola",
      dependencies({ context: context({ profile: null }) })
    );

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("agent_profile_missing");
  });

  it("bloquea un perfil desactivado en conversación real", async () => {
    const base = context();
    const result = await run(
      "Hola",
      dependencies({
        context: context({ profile: { ...base.profile!, enabled: false } }),
      })
    );

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("agent_profile_disabled");
  });

  it("bloquea una ventana de WhatsApp cerrada", async () => {
    const result = await run(
      "Hola",
      dependencies({ whatsappWindowOpen: false })
    );

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("whatsapp_window_closed");
  });

  it("enruta handoff sin ejecutarlo", async () => {
    const result = await run(
      "Quiero hablar con un asesor",
      dependencies()
    );

    expect(result.intent).toBe("handoff");
    expect(result.wouldExecute).toBe("handoff");
    expect(result.blocked).toBe(false);
    expect(result.trace).toContain("handoff_decision");
  });

  it("enruta cancelación a confirmación pendiente", async () => {
    const result = await run("Cancela mi cita", dependencies());

    expect(result.intent).toBe("cancel");
    expect(result.wouldExecute).toBe("set_pending_cancel");
    expect(result.wouldReply).toContain("confirmación");
  });

  it("enruta scheduling al motor de ofertas", async () => {
    const result = await run("Quiero agendar una cita", dependencies());

    expect(result.intent).toBe("scheduling");
    expect(result.wouldExecute).toBe("offer_slots");
    expect(result.trace).toContain("scheduling_decision");
  });

  it("enruta conversación general mediante la decisión validada", async () => {
    const deps = dependencies({
      proposedAction: { action: "reply", text: "Hola, ¿cómo te ayudo?" },
    });
    const result = await run("Hola", deps);

    expect(result.intent).toBe("general");
    expect(result.wouldExecute).toBe("reply");
    expect(result.wouldReply).toBe("Hola, ¿cómo te ayudo?");
    expect(deps.proposeAction).toHaveBeenCalledOnce();
  });

  it("degrada una acción inválida y falla cerrado", async () => {
    const result = await run(
      "Hola",
      dependencies({ proposedAction: { action: "delete_everything" } })
    );

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("action_invalid");
    expect(result.validatedAction).toEqual({ action: "none" });
    expect(result.wouldExecute).toBeNull();
  });

  it("falla cerrado cuando el modelo rechaza la decisión", async () => {
    const deps = dependencies();
    deps.proposeAction = vi.fn().mockRejectedValue(new Error("provider_down"));

    const result = await run("Hola", deps);

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("decision_failed");
    expect(result.wouldExecute).toBeNull();
  });

  it.each(["book_slot", "reschedule_slot"] as const)(
    "bloquea %s inventado por el modelo",
    async (action) => {
      const result = await run(
        "Hola",
        dependencies({
          proposedAction: {
            action,
            startUtc: "2026-10-02T16:00:00.000Z",
          },
        })
      );

      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("slot_not_offered");
      expect(result.validatedAction).toEqual({ action: "none" });
      expect(result.wouldExecute).toBeNull();
    }
  );

  it("permite continuar en shadow cuando el modelo usa una oferta exacta", async () => {
    const offered = "2026-10-01T16:00:00.000Z";
    const result = await run(
      "Hola",
      dependencies({
        context: context({
          offers: [{ startUtc: offered, label: "jueves 1 a las 10:00" }],
        }),
        proposedAction: { action: "book_slot", startUtc: offered },
      })
    );

    expect(result.blocked).toBe(false);
    expect(result.validatedAction).toMatchObject({
      action: "book_slot",
      startUtc: offered,
    });
    expect(result.wouldExecute).toBe("revalidate_then_set_pending_book");
  });

  it("distingue una oferta histórica de disponibilidad actual", async () => {
    const offered = "2026-09-30T19:20:00.000Z";
    const result = await run(
      "2:20",
      dependencies({
        context: context({
          settings: {
            ...DEFAULT_CALENDAR_SETTINGS,
            timezone: "America/Matamoros",
          },
          offers: [{ startUtc: offered, label: "mié 30 sep, 14:20" }],
          lastOutboundText: [
            "Mañana miércoles, 30 de septiembre",
            "• 14:20",
          ].join("\n"),
          lastOutboundAt: new Date("2026-09-30T02:10:19.000Z"),
        }),
      })
    );

    expect(result.blocked).toBe(false);
    expect(result.wouldExecute).toBe("revalidate_then_set_pending_book");
    expect(result.wouldReply).toContain("opción previamente ofrecida");
    expect(result.wouldReply).toContain("revalidar");
    expect(result.wouldReply).not.toMatch(/^Perfecto\. Tengo .* disponible/);
  });

  it("bloquea capacidades de agenda cuando están deshabilitadas", async () => {
    const result = await run(
      "Quiero agendar una cita",
      dependencies({ agendaEnabled: false })
    );

    expect(result.intent).toBe("scheduling");
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("agenda_disabled");
    expect(result.validatedAction).toEqual({ action: "none" });
  });

  it.each([
    { action: "reply", text: "Te agendo una cita" },
    { action: "update_lead", note: "interés", reply: "Te agendo una cita" },
    { action: "move_stage", stage: "Nuevo", reply: "Te agendo una cita" },
    { action: "handoff", farewell: "Te agendo una cita" },
    { action: "offer_slots", reply: "Te agendo una cita" },
  ])("protege todos los textos de salida: $action", async (proposedAction) => {
    const result = await run(
      "Hola",
      dependencies({ agendaEnabled: false, proposedAction })
    );
    const action = result.validatedAction as Record<string, unknown>;
    const text = action.text ?? action.reply ?? action.farewell;

    expect(text).toContain("no puedo agendar citas");
  });

  it.each(["book_slot", "reschedule_slot"] as const)(
    "protege el texto de salida de %s",
    async (action) => {
      const offered = "2026-10-01T16:00:00.000Z";
      const result = await run(
        "Hola",
        dependencies({
          agendaEnabled: false,
          context: context({
            offers: [{ startUtc: offered, label: "jueves 1 a las 10:00" }],
          }),
          proposedAction: {
            action,
            startUtc: offered,
            reply: "Te agendo una cita",
          },
        })
      );

      expect(result.blocked).toBe(true);
      expect(result.reason).toBe("agenda_disabled");
      expect(result.validatedAction).toMatchObject({
        action: "reply",
        text: expect.stringContaining("no puedo agendar citas"),
      });
    }
  );

  it("simula una confirmación pendiente sin ejecutar la reserva", async () => {
    const result = await run(
      "sí",
      dependencies({
        context: context({
          pendingAction: {
            id: "pending_1",
            action: "book",
            bookingId: null,
            startUtc: "2026-10-01T16:00:00.000Z",
            serviceId: null,
            professionalId: null,
            expiresAt: new Date("2026-09-30T18:30:00.000Z"),
          },
        }),
      })
    );

    expect(result.intent).toBe("scheduling");
    expect(result.wouldExecute).toBe("book_slot");
    expect(result.trace).not.toContain("intent_router");
  });

  it("mantiene aislamiento entre organizaciones", async () => {
    const loadContext = vi.fn(async (input: { expectedOrganizationId: string }) => ({
      context: context({}, input.expectedOrganizationId),
      commercialAccess: true,
      agendaEnabled: true,
      whatsappWindowOpen: true,
    }));
    const deps: ShadowGraphDependencies = {
      now: () => NOW,
      loadContext,
      proposeAction: async () => ({ action: "none" }),
    };

    const [orgA, orgB] = await Promise.all([
      run("Hola", deps, "org_a"),
      run("Hola", deps, "org_b"),
    ]);

    expect(orgA.organizationId).toBe("org_a");
    expect(orgB.organizationId).toBe("org_b");
    expect(orgA.blocked).toBe(false);
    expect(orgB.blocked).toBe(false);
    expect(loadContext).toHaveBeenCalledWith(
      expect.objectContaining({ expectedOrganizationId: "org_a" })
    );
    expect(loadContext).toHaveBeenCalledWith(
      expect.objectContaining({ expectedOrganizationId: "org_b" })
    );
  });
});
