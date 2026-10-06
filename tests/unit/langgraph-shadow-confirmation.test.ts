import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CALENDAR_SETTINGS } from "@/server/agenda/settings";
import { runShadowAgent, type ShadowGraphDependencies } from "@/server/ai/graph/graph";
import type { ShadowContext } from "@/server/ai/graph/state";

/**
 * Modo sombra (`graph.ts`): el enrutador de la acción pendiente usa el mismo
 * detector estricto que el pipeline. Una negativa o un "sí" condicionado no
 * pueden simular la ejecución de la acción pendiente.
 */

const NOW = new Date("2026-09-30T18:00:00.000Z");

function context(pendingAction: ShadowContext["pendingAction"], inbound: string): ShadowContext {
  return {
    now: NOW,
    conversation: {
      id: "conv_1",
      organizationId: "org_a",
      contactId: "contact_1",
      isTest: false,
      aiEnabled: true,
      handoffAt: null,
      lastInboundAt: new Date("2026-09-30T17:55:00.000Z"),
    },
    profile: {
      id: "profile_1",
      organizationId: "org_a",
      enabled: true,
      name: "Asistente",
      tone: null,
      instructions: null,
      escalationRules: null,
      greeting: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    history: [{ role: "user", content: inbound }],
    lastInboundMessageId: "msg_in_1",
    lastInboundText: inbound,
    lastOutboundText: "Perfecto. Tengo jueves 1 a las 10:00 disponible. ¿Quiere que agende su cita?",
    lastOutboundAt: new Date("2026-09-30T17:54:00.000Z"),
    kb: [],
    stages: [{ id: "stage_1", name: "Nuevo" }],
    settings: DEFAULT_CALENDAR_SETTINGS,
    offers: [],
    pendingAction,
  };
}

function pending(action: "book" | "reschedule" | "cancel"): ShadowContext["pendingAction"] {
  return {
    id: "pending_1",
    action,
    bookingId: action === "reschedule" ? "booking_1" : null,
    startUtc: action === "cancel" ? null : "2026-10-01T16:00:00.000Z",
    serviceId: null,
    professionalId: null,
    expiresAt: new Date("2026-09-30T18:30:00.000Z"),
  };
}

async function run(inbound: string, action: "book" | "reschedule" | "cancel") {
  const deps: ShadowGraphDependencies = {
    now: () => NOW,
    loadContext: vi.fn(async () => ({
      context: context(pending(action), inbound),
      commercialAccess: true,
      agendaEnabled: true,
      whatsappWindowOpen: true,
    })),
    proposeAction: vi.fn(async () => ({ action: "reply", text: "Respuesta segura" })),
    findSlot: vi.fn(async (_org, startUtc) => ({ startUtc, endUtc: startUtc, label: "disponible" })),
    findProfessionalSlot: vi.fn(async (_org, slot) => ({
      startUtc: slot.startUtc,
      endUtc: slot.startUtc,
      label: "disponible",
    })),
  };
  return runShadowAgent(
    { conversationId: "conv_1", expectedOrganizationId: "org_a", expectedInboundMessageId: "msg_in_1" },
    { dependencies: deps }
  );
}

const EXECUTES = { book: "book_slot", reschedule: "reschedule_slot", cancel: "cancel_booking" } as const;
const NEGATIVE = ["claro que no", "sí pero a las 5", "ok no", "por favor no", "sí, ¿y cuánto cuesta?", "vale, pero mejor el jueves"];

describe("modo sombra: solo una confirmación explícita ejecuta la acción pendiente", () => {
  it.each(["book", "reschedule", "cancel"] as const)("pendiente %s: 'sí' simula la ejecución", async (action) => {
    const result = await run("sí", action);
    expect(result.wouldExecute).toBe(EXECUTES[action]);
  });

  it("barrido: ninguna negativa ni 'sí' condicionado simula la ejecución", async () => {
    const branches = { executed: 0, notExecuted: 0 };
    for (const action of ["book", "reschedule", "cancel"] as const) {
      for (const text of ["sí", ...NEGATIVE]) {
        const result = await run(text, action);
        const executed = result.wouldExecute === EXECUTES[action];
        if (text === "sí") {
          expect(executed, `${action} '${text}'`).toBe(true);
          branches.executed += 1;
        } else {
          expect(executed, `${action} '${text}'`).toBe(false);
          branches.notExecuted += 1;
        }
      }
    }
    expect(branches.executed).toBeGreaterThan(0);
    expect(branches.notExecuted).toBeGreaterThan(0);
  });
});
